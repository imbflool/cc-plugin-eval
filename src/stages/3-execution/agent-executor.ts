/**
 * Agent executor for Stage 3: Execution.
 *
 * Executes test scenarios through the Claude Agent SDK with
 * plugin loaded. Captures tool invocations via PreToolUse hooks
 * and tracks success/failure via PostToolUse/PostToolUseFailure hooks
 * for programmatic detection in Stage 4.
 */

import { DEFAULT_TUNING } from "../../config/defaults.js";
import { getModelPricing } from "../../config/pricing.js";
import { logger } from "../../utils/logging.js";
import { withRetry } from "../../utils/retry.js";

import { createHookResponseCollector } from "./hook-capture.js";
import {
  executeQuery,
  isErrorMessage,
  isResultMessage,
  isUserMessage,
  type SDKMessage,
  type QueryInput,
  type QueryObject,
  type PluginReference,
  type PreToolUseHookConfig,
  type PostToolUseHookConfig,
  type PostToolUseFailureHookConfig,
  type SubagentStartHookConfig,
  type SubagentStopHookConfig,
  type SettingSource,
  type ModelUsage,
} from "./sdk-client.js";
import {
  createPreToolUseHook,
  createPostToolUseHook,
  createPostToolUseFailureHook,
  createSubagentStartHook,
  createSubagentStopHook,
} from "./tool-capture-hooks.js";
import {
  buildTranscript,
  createErrorEvent,
  type TranscriptBuilderContext,
} from "./transcript-builder.js";

import type {
  ExecutionConfig,
  ExecutionResult,
  TestScenario,
  TranscriptErrorEvent,
  ToolCapture,
  SubagentCapture,
} from "../../types/index.js";

/**
 * Query function type for dependency injection in tests.
 */
export type QueryFunction = (input: QueryInput) => QueryObject;

/**
 * Scenario execution options.
 */
export interface ScenarioExecutionOptions {
  /** Scenario to execute */
  scenario: TestScenario;
  /** Path to plugin */
  pluginPath: string;
  /** Plugin name for transcript */
  pluginName: string;
  /** Execution configuration */
  config: ExecutionConfig;
  /** Additional plugins for conflict testing */
  additionalPlugins?: string[] | undefined;
  /** Query function (for testing/dependency injection) */
  queryFn?: QueryFunction | undefined;
  /**
   * Enable MCP server discovery via settingSources.
   * When true (default), uses settingSources: ["project"] which enables
   * the SDK to discover MCP servers from .mcp.json files.
   * When false, uses settingSources: [] to skip MCP discovery and
   * avoid the 60-second MCP channel closure timeout.
   *
   * @default true
   */
  enableMcpDiscovery?: boolean | undefined;
}

/**
 * Hook configuration for all hook types.
 */
interface HooksConfig {
  preToolUse: PreToolUseHookConfig[];
  postToolUse: PostToolUseHookConfig[];
  postToolUseFailure: PostToolUseFailureHookConfig[];
  subagentStart: SubagentStartHookConfig[];
  subagentStop: SubagentStopHookConfig[];
}

/**
 * Build query input for scenario execution.
 */
function buildQueryInput(
  scenario: TestScenario,
  plugins: PluginReference[],
  config: ExecutionConfig,
  hooks: HooksConfig,
  abortController: AbortController,
  startTime: number,
  enableMcpDiscovery: boolean,
): QueryInput {
  // Build allowed tools list - ensure trigger tools are always included
  const allowedTools = [
    ...(config.allowed_tools ?? []),
    "Skill",
    "SlashCommand",
    "Task",
    "Read",
    "Glob",
    "Grep",
  ];

  // Determine settingSources based on MCP discovery option
  const settingSources: SettingSource[] = enableMcpDiscovery ? ["project"] : [];

  return {
    prompt: scenario.user_prompt,
    options: {
      plugins,
      settingSources,
      allowedTools,
      disallowedTools: config.disallowed_tools,
      model: config.model,
      // Use Claude Code system prompt for accurate plugin evaluation
      systemPrompt: { type: "preset", preset: "claude_code" },
      maxTurns: config.max_turns,
      persistSession: false, // Session isolation
      maxBudgetUsd: config.max_budget_usd,
      abortController,
      permissionMode: config.permission_bypass
        ? "bypassPermissions"
        : "default",
      allowDangerouslySkipPermissions: config.permission_bypass,
      ...(config.max_thinking_tokens !== undefined
        ? { maxThinkingTokens: config.max_thinking_tokens }
        : {}),
      hooks: {
        PreToolUse: hooks.preToolUse,
        PostToolUse: hooks.postToolUse,
        PostToolUseFailure: hooks.postToolUseFailure,
        SubagentStart: hooks.subagentStart,
        SubagentStop: hooks.subagentStop,
      },
      stderr: (data: string): void => {
        const elapsed = Date.now() - startTime;
        logger.debug(
          `[Scenario ${scenario.id} ${String(elapsed)}ms] SDK stderr: ${data.trim()}`,
        );
      },
    },
  };
}

/**
 * Extract metrics from SDK result message.
 */
function extractResultMetrics(messages: SDKMessage[]): {
  costUsd: number;
  durationMs: number;
  numTurns: number;
  permissionDenials: string[];
  modelUsage?: Record<string, ModelUsage>;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  const resultMsg = messages.find(isResultMessage);

  // Calculate aggregate cache tokens from modelUsage
  const modelUsage = resultMsg?.modelUsage;
  const cacheReadTokens = modelUsage
    ? Object.values(modelUsage).reduce(
        (sum, m) => sum + (m.cacheReadInputTokens ?? 0),
        0,
      )
    : 0;
  const cacheCreationTokens = modelUsage
    ? Object.values(modelUsage).reduce(
        (sum, m) => sum + (m.cacheCreationInputTokens ?? 0),
        0,
      )
    : 0;

  return {
    costUsd: resultMsg?.total_cost_usd ?? 0,
    durationMs: resultMsg?.duration_ms ?? 0,
    numTurns: resultMsg?.num_turns ?? 0,
    permissionDenials: resultMsg?.permission_denials ?? [],
    ...(modelUsage !== undefined ? { modelUsage } : {}),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

/**
 * Execute a single test scenario.
 *
 * Runs the scenario through the Agent SDK with the plugin loaded,
 * capturing all tool invocations via PreToolUse hooks.
 *
 * @param options - Scenario execution options
 * @returns Execution result with transcript and captured tools
 *
 * @example
 * ```typescript
 * const result = await executeScenario({
 *   scenario: testScenario,
 *   pluginPath: './my-plugin',
 *   pluginName: 'my-plugin',
 *   config: executionConfig,
 * });
 *
 * console.log(`Detected ${result.detected_tools.length} tool calls`);
 * ```
 */
export async function executeScenario(
  options: ScenarioExecutionOptions,
): Promise<ExecutionResult> {
  const {
    scenario,
    pluginPath,
    pluginName,
    config,
    additionalPlugins = [],
    queryFn,
  } = options;

  const messages: SDKMessage[] = [];
  const detectedTools: ToolCapture[] = [];
  const subagentCaptures: SubagentCapture[] = [];
  const errors: TranscriptErrorEvent[] = [];

  // Create hook response collector for capturing SDK hook messages
  const hookCollector = createHookResponseCollector();

  // Abort controller for timeout handling
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms);
  const startTime = Date.now();

  try {
    // Build plugin list
    const plugins: PluginReference[] = [{ type: "local", path: pluginPath }];
    for (const additionalPath of additionalPlugins) {
      plugins.push({ type: "local", path: additionalPath });
    }

    // Create tool capture hooks with correlation map
    const captureMap = new Map<string, ToolCapture>();
    const preHook = createPreToolUseHook(captureMap, (capture) =>
      detectedTools.push(capture),
    );
    const postHook = createPostToolUseHook(captureMap);
    const postFailureHook = createPostToolUseFailureHook(captureMap);

    // Create subagent capture hooks with correlation map
    const subagentCaptureMap = new Map<string, SubagentCapture>();
    const subagentStartHook = createSubagentStartHook(
      subagentCaptureMap,
      (capture) => subagentCaptures.push(capture),
    );
    const subagentStopHook = createSubagentStopHook(subagentCaptureMap);

    // Configure hooks for each event type
    const hooksConfig: HooksConfig = {
      preToolUse: [{ matcher: ".*", hooks: [preHook] }],
      postToolUse: [{ matcher: ".*", hooks: [postHook] }],
      postToolUseFailure: [{ matcher: ".*", hooks: [postFailureHook] }],
      subagentStart: [{ matcher: ".*", hooks: [subagentStartHook] }],
      subagentStop: [{ matcher: ".*", hooks: [subagentStopHook] }],
    };

    // Build query input
    const queryInput = buildQueryInput(
      scenario,
      plugins,
      config,
      hooksConfig,
      controller,
      startTime,
      options.enableMcpDiscovery ?? true,
    );

    // Execute with retry for transient errors
    await withRetry(async () => {
      // Use provided query function or real SDK
      const q = queryFn ? queryFn(queryInput) : executeQuery(queryInput);

      for await (const message of q) {
        messages.push(message);

        // Process message for hook responses
        hookCollector.processMessage(message);

        // Capture errors for transcript
        if (isErrorMessage(message)) {
          errors.push({
            type: "error",
            error_type: "api_error",
            message: message.error ?? "Unknown error",
            timestamp: Date.now(),
            recoverable: false,
          });
        }
      }
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    errors.push(createErrorEvent(err, isTimeout));
  } finally {
    clearTimeout(timeout);
  }

  // Extract metrics from result message
  const metrics = extractResultMetrics(messages);

  // Build transcript context
  const context: TranscriptBuilderContext = {
    scenario,
    pluginName,
    model: config.model,
  };

  return {
    scenario_id: scenario.id,
    transcript: buildTranscript(context, messages, errors),
    detected_tools: detectedTools,
    hook_responses: hookCollector.responses,
    ...(subagentCaptures.length > 0
      ? { subagent_captures: subagentCaptures }
      : {}),
    cost_usd: metrics.costUsd,
    api_duration_ms: metrics.durationMs,
    num_turns: metrics.numTurns,
    permission_denials: metrics.permissionDenials,
    errors,
    ...(metrics.modelUsage !== undefined
      ? { model_usage: metrics.modelUsage }
      : {}),
    cache_read_tokens: metrics.cacheReadTokens,
    cache_creation_tokens: metrics.cacheCreationTokens,
  };
}

/**
 * Execute a scenario with file checkpointing.
 *
 * For scenarios that test commands/skills that modify files,
 * this enables file checkpointing to undo changes between tests.
 *
 * @param options - Scenario execution options
 * @returns Execution result
 */
export async function executeScenarioWithCheckpoint(
  options: ScenarioExecutionOptions,
): Promise<ExecutionResult> {
  const {
    scenario,
    pluginPath,
    pluginName,
    config,
    additionalPlugins = [],
    queryFn,
    enableMcpDiscovery = true,
  } = options;

  const messages: SDKMessage[] = [];
  const detectedTools: ToolCapture[] = [];
  const subagentCaptures: SubagentCapture[] = [];
  const errors: TranscriptErrorEvent[] = [];
  let userMessageId: string | undefined;

  // Create hook response collector for capturing SDK hook messages
  const hookCollector = createHookResponseCollector();

  // Abort controller for timeout handling
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms);

  // Determine settingSources based on MCP discovery option
  const settingSources: SettingSource[] = enableMcpDiscovery ? ["project"] : [];

  try {
    // Build plugin list
    const plugins: PluginReference[] = [{ type: "local", path: pluginPath }];
    for (const additionalPath of additionalPlugins) {
      plugins.push({ type: "local", path: additionalPath });
    }

    // Create tool capture hooks with correlation map
    const captureMap = new Map<string, ToolCapture>();
    const preHook = createPreToolUseHook(captureMap, (capture) =>
      detectedTools.push(capture),
    );
    const postHook = createPostToolUseHook(captureMap);
    const postFailureHook = createPostToolUseFailureHook(captureMap);

    // Create subagent capture hooks with correlation map
    const subagentCaptureMap = new Map<string, SubagentCapture>();
    const subagentStartHook = createSubagentStartHook(
      subagentCaptureMap,
      (capture) => subagentCaptures.push(capture),
    );
    const subagentStopHook = createSubagentStopHook(subagentCaptureMap);

    // Build query input with file checkpointing enabled
    const queryInput: QueryInput = {
      prompt: scenario.user_prompt,
      options: {
        plugins,
        settingSources,
        allowedTools: [
          ...(config.allowed_tools ?? []),
          "Skill",
          "SlashCommand",
          "Task",
          "Read",
          "Glob",
          "Grep",
        ],
        disallowedTools: config.disallowed_tools,
        model: config.model,
        // Use Claude Code system prompt for accurate plugin evaluation
        systemPrompt: { type: "preset", preset: "claude_code" },
        maxTurns: config.max_turns,
        persistSession: false,
        maxBudgetUsd: config.max_budget_usd,
        abortController: controller,
        permissionMode: config.permission_bypass
          ? "bypassPermissions"
          : "default",
        allowDangerouslySkipPermissions: config.permission_bypass,
        enableFileCheckpointing: true, // Enable for rewind
        hooks: {
          PreToolUse: [{ matcher: ".*", hooks: [preHook] }],
          PostToolUse: [{ matcher: ".*", hooks: [postHook] }],
          PostToolUseFailure: [{ matcher: ".*", hooks: [postFailureHook] }],
          SubagentStart: [{ matcher: ".*", hooks: [subagentStartHook] }],
          SubagentStop: [{ matcher: ".*", hooks: [subagentStopHook] }],
        },
      },
    };

    // Execute with retry
    await withRetry(async () => {
      const q = queryFn ? queryFn(queryInput) : executeQuery(queryInput);

      for await (const message of q) {
        messages.push(message);

        // Process message for hook responses
        hookCollector.processMessage(message);

        // Capture user message ID for potential rewind
        if (isUserMessage(message) && "uuid" in message) {
          userMessageId = message.uuid;
        }

        // Capture errors
        if (isErrorMessage(message)) {
          errors.push({
            type: "error",
            error_type: "api_error",
            message: message.error ?? "Unknown error",
            timestamp: Date.now(),
            recoverable: false,
          });
        }
      }

      // Rewind file changes after execution if we have the Query object
      // The SDK's query() returns an object with rewindFiles method
      if (userMessageId && typeof q.rewindFiles === "function") {
        try {
          await q.rewindFiles(userMessageId);
          logger.debug(`Reverted file changes for scenario: ${scenario.id}`);
        } catch (rewindErr) {
          logger.warn(
            `Failed to rewind files for ${scenario.id}: ${rewindErr instanceof Error ? rewindErr.message : String(rewindErr)}`,
          );
        }
      }
    });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    errors.push(createErrorEvent(err, isTimeout));
  } finally {
    clearTimeout(timeout);
  }

  // Extract metrics
  const metrics = extractResultMetrics(messages);

  // Build transcript
  const context: TranscriptBuilderContext = {
    scenario,
    pluginName,
    model: config.model,
  };

  return {
    scenario_id: scenario.id,
    transcript: buildTranscript(context, messages, errors),
    detected_tools: detectedTools,
    hook_responses: hookCollector.responses,
    ...(subagentCaptures.length > 0
      ? { subagent_captures: subagentCaptures }
      : {}),
    cost_usd: metrics.costUsd,
    api_duration_ms: metrics.durationMs,
    num_turns: metrics.numTurns,
    permission_denials: metrics.permissionDenials,
    errors,
    ...(metrics.modelUsage !== undefined
      ? { model_usage: metrics.modelUsage }
      : {}),
    cache_read_tokens: metrics.cacheReadTokens,
    cache_creation_tokens: metrics.cacheCreationTokens,
  };
}

/**
 * Calculate estimated cost for scenario execution.
 *
 * @param scenarioCount - Number of scenarios
 * @param config - Execution configuration
 * @returns Estimated cost in USD
 */
export function estimateExecutionCost(
  scenarioCount: number,
  config: ExecutionConfig,
): number {
  // Token estimates from tuning config
  const inputTokensPerScenario =
    DEFAULT_TUNING.token_estimates.input_per_turn * config.max_turns;
  const outputTokensPerScenario =
    DEFAULT_TUNING.token_estimates.output_per_turn * config.max_turns;

  // Get pricing from centralized config
  const pricing = getModelPricing(config.model);

  const totalInputTokens = inputTokensPerScenario * scenarioCount;
  const totalOutputTokens = outputTokensPerScenario * scenarioCount;

  const inputCost = (totalInputTokens / 1_000_000) * pricing.input;
  const outputCost = (totalOutputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}

/**
 * Check if execution would exceed budget.
 *
 * @param scenarioCount - Number of scenarios
 * @param config - Execution configuration
 * @returns True if estimated cost exceeds budget
 */
export function wouldExceedBudget(
  scenarioCount: number,
  config: ExecutionConfig,
): boolean {
  const estimatedCost = estimateExecutionCost(scenarioCount, config);
  return estimatedCost > config.max_budget_usd;
}

/**
 * Format execution statistics for logging.
 *
 * @param results - Execution results
 * @returns Formatted statistics string
 */
export function formatExecutionStats(results: ExecutionResult[]): string {
  const totalCost = results.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.api_duration_ms, 0);
  const totalTurns = results.reduce((sum, r) => sum + r.num_turns, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);
  const totalTools = results.reduce(
    (sum, r) => sum + r.detected_tools.length,
    0,
  );

  const lines = [
    `Execution Statistics:`,
    `  Scenarios: ${String(results.length)}`,
    `  Total cost: $${totalCost.toFixed(4)}`,
    `  Total duration: ${String(Math.round(totalDuration / 1000))}s`,
    `  Total turns: ${String(totalTurns)}`,
    `  Total tools captured: ${String(totalTools)}`,
    `  Errors: ${String(totalErrors)}`,
  ];

  if (totalErrors > 0) {
    const errorScenarios = results.filter((r) => r.errors.length > 0);
    lines.push(
      `  Failed scenarios: ${errorScenarios.map((r) => r.scenario_id).join(", ")}`,
    );
  }

  return lines.join("\n");
}
