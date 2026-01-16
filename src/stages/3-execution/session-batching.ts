/**
 * Session batching utilities for Stage 3: Execution.
 *
 * Implements session reuse across scenarios testing the same component
 * to reduce subprocess startup overhead (~80% reduction).
 */

import { logger } from "../../utils/logging.js";
import { withRetry } from "../../utils/retry.js";

import { createHookResponseCollector } from "./hook-capture.js";
import {
  executeQuery,
  isErrorMessage,
  isResultMessage,
  type PluginReference,
  type QueryInput,
  type SDKMessage,
  type SettingSource,
} from "./sdk-client.js";
import {
  buildTranscript,
  type TranscriptBuilderContext,
} from "./transcript-builder.js";

import type { QueryFunction } from "./agent-executor.js";
import type {
  ExecutionConfig,
  ExecutionResult,
  HookResponseCapture,
  SessionStrategy,
  TestScenario,
  ToolCapture,
  TranscriptErrorEvent,
} from "../../types/index.js";

/**
 * Resolve the effective session strategy from config.
 *
 * Handles backward compatibility with the deprecated `session_isolation` field.
 * When `session_strategy` is set, it takes precedence.
 *
 * @param config - Execution configuration
 * @returns Effective session strategy
 */
export function resolveSessionStrategy(
  config: ExecutionConfig,
): SessionStrategy {
  // If session_strategy is explicitly set, use it
  if (config.session_strategy !== undefined) {
    return config.session_strategy;
  }

  // Fall back to session_isolation for backward compatibility
  // true = isolated, false (default) = batched_by_component
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return config.session_isolation ? "isolated" : "batched_by_component";
}

/**
 * Create a hash for additional plugins to use as part of the batch key.
 */
function hashPlugins(plugins: string[]): string {
  if (plugins.length === 0) {
    return "";
  }
  return plugins.slice().sort().join("|");
}

/**
 * Group scenarios by component reference.
 *
 * Scenarios testing the same component are grouped together
 * so they can share a session for batched execution.
 *
 * @param scenarios - Scenarios to group
 * @param additionalPlugins - Additional plugins loaded for all scenarios
 * @returns Map of group key to scenarios
 */
export function groupScenariosByComponent(
  scenarios: TestScenario[],
  additionalPlugins: string[] = [],
): Map<string, TestScenario[]> {
  const groups = new Map<string, TestScenario[]>();
  const pluginHash = hashPlugins(additionalPlugins);

  for (const scenario of scenarios) {
    // Create group key from component reference and plugin hash
    const key = `${scenario.component_ref}::${pluginHash}`;

    const group = groups.get(key);
    if (group) {
      group.push(scenario);
    } else {
      groups.set(key, [scenario]);
    }
  }

  return groups;
}

/**
 * Options for batch execution.
 */
export interface BatchExecutionOptions {
  /** Scenarios in this batch (same component) */
  scenarios: TestScenario[];
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
  /** Progress callback */
  onScenarioComplete?:
    | ((result: ExecutionResult, index: number) => void)
    | undefined;
  /** Enable file checkpointing to revert file changes after each scenario */
  useCheckpointing?: boolean | undefined;
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
 * Options for building a scenario query input.
 */
interface BuildScenarioQueryInputOptions {
  /** The scenario to execute */
  scenario: TestScenario;
  /** Plugin references to load */
  plugins: PluginReference[];
  /** Tools to allow */
  allowedTools: string[];
  /** Tools to disallow */
  disallowedTools?: string[] | undefined;
  /** Model to use */
  model: string;
  /** Max turns per scenario */
  maxTurns: number;
  /** Max budget per scenario */
  maxBudgetUsd?: number | undefined;
  /** Whether this is the first scenario in the batch */
  isFirst: boolean;
  /** Abort signal for timeout */
  abortSignal: AbortSignal;
  /** Map for correlating Pre/Post hooks by toolUseId */
  captureMap: Map<string, ToolCapture>;
  /** Tool capture callback */
  onToolCapture: (capture: ToolCapture) => void;
  /** Stderr handler */
  onStderr: (data: string) => void;
  /** Enable file checkpointing for rewind support */
  enableFileCheckpointing?: boolean | undefined;
  /** Enable MCP server discovery via settingSources */
  enableMcpDiscovery?: boolean | undefined;
}

/**
 * Options for executing a scenario with retry.
 */
interface ExecuteScenarioWithRetryOptions {
  /** The scenario to execute */
  scenario: TestScenario;
  /** Current scenario index in batch */
  scenarioIndex: number;
  /** Total scenarios in batch */
  totalScenarios: number;
  /** Plugin references to load */
  plugins: PluginReference[];
  /** Tools to allow */
  allowedTools: string[];
  /** Execution configuration */
  config: ExecutionConfig;
  /** Enable file checkpointing */
  useCheckpointing: boolean;
  /** Enable MCP server discovery */
  enableMcpDiscovery?: boolean | undefined;
  /** Abort controller for timeout */
  controller: AbortController;
  /** Start time for logging */
  startTime: number;
  /** Plugin name for logging */
  pluginName: string;
  /** Query function (for testing) */
  queryFn?: QueryFunction | undefined;
}

/**
 * Result from executing a scenario with retry.
 */
interface ExecuteScenarioWithRetryResult {
  /** Messages collected during execution */
  messages: SDKMessage[];
  /** Tools detected via PreToolUse hooks */
  detectedTools: ToolCapture[];
  /** Hook responses collected */
  hookResponses: HookResponseCapture[];
  /** Errors encountered */
  errors: TranscriptErrorEvent[];
  /** User message ID for file checkpointing */
  userMessageId: string | undefined;
}

/**
 * Execute a single scenario with retry support.
 *
 * Handles query building, execution, message collection, hook processing,
 * and file checkpointing rewind.
 *
 * @param options - Scenario execution options
 * @returns Execution result with messages, tools, hooks, and errors
 */
async function executeScenarioWithRetry(
  options: ExecuteScenarioWithRetryOptions,
): Promise<ExecuteScenarioWithRetryResult> {
  const {
    scenario,
    scenarioIndex,
    totalScenarios,
    plugins,
    allowedTools,
    config,
    useCheckpointing,
    enableMcpDiscovery,
    controller,
    startTime,
    pluginName,
    queryFn,
  } = options;

  const scenarioMessages: SDKMessage[] = [];
  const scenarioErrors: TranscriptErrorEvent[] = [];
  const detectedTools: ToolCapture[] = [];
  const hookCollector = createHookResponseCollector();
  let userMessageId: string | undefined;

  // Create capture map for correlating Pre/Post hooks by toolUseId
  const captureMap = new Map<string, ToolCapture>();

  logger.debug(
    `Batch: executing scenario ${String(scenarioIndex + 1)}/${String(totalScenarios)}: ${scenario.id}`,
  );

  // Build query input
  const queryInput = buildScenarioQueryInput({
    scenario,
    plugins,
    allowedTools,
    disallowedTools: config.disallowed_tools,
    model: config.model,
    maxTurns: config.max_turns,
    maxBudgetUsd: config.max_budget_usd,
    isFirst: scenarioIndex === 0,
    abortSignal: controller.signal,
    captureMap,
    onToolCapture: (capture) => detectedTools.push(capture),
    onStderr: (data) => {
      const elapsed = Date.now() - startTime;
      console.error(
        `[Batch ${pluginName} ${String(elapsed)}ms] SDK stderr:`,
        data.trim(),
      );
    },
    enableFileCheckpointing: useCheckpointing,
    enableMcpDiscovery,
  });

  // Execute with retry for transient errors
  // Keep reference to query object for rewindFiles
  let queryObject: Awaited<ReturnType<typeof executeQuery>> | undefined;
  await withRetry(async () => {
    const q = queryFn ? queryFn(queryInput) : executeQuery(queryInput);
    queryObject = q;

    for await (const message of q) {
      scenarioMessages.push(message);
      hookCollector.processMessage(message);

      // Capture the FIRST user message ID for file checkpointing.
      // We only need the first because we want to rewind to the state
      // before the scenario prompt, not any follow-up messages.
      // Note: /clear commands are sent via a separate query object
      // (sendClearCommand), so they don't appear in this iteration.
      if (message.type === "user" && !userMessageId) {
        // SDK may use 'id' or 'uuid' for the message identifier
        const msgId =
          (message as { id?: string }).id ??
          (message as { uuid?: string }).uuid;
        if (msgId) {
          userMessageId = msgId;
        }
      }

      // Capture errors
      if (isErrorMessage(message)) {
        scenarioErrors.push({
          type: "error",
          error_type: "api_error",
          message: message.error ?? "Unknown error",
          timestamp: Date.now(),
          recoverable: false,
        });
      }
    }

    // Rewind file changes after scenario execution if checkpointing is enabled.
    // This works with persistSession: true because the SDK maintains file
    // checkpoints per message ID, independent of session state. The rewind
    // happens BEFORE /clear is sent, ensuring filesystem is reset while
    // keeping the session alive for the next scenario.
    if (useCheckpointing && userMessageId) {
      await rewindFileChanges(queryObject, userMessageId, scenario.id);
    }
  });

  return {
    messages: scenarioMessages,
    detectedTools,
    hookResponses: hookCollector.responses,
    errors: scenarioErrors,
    userMessageId,
  };
}

/**
 * Build query input for a scenario in a batch.
 *
 * @param options - Query input options
 * @returns Query input for the Agent SDK
 */
function buildScenarioQueryInput(
  options: BuildScenarioQueryInputOptions,
): QueryInput {
  const {
    scenario,
    plugins,
    allowedTools,
    disallowedTools,
    model,
    maxTurns,
    maxBudgetUsd,
    isFirst,
    abortSignal,
    captureMap,
    onToolCapture,
    onStderr,
    enableFileCheckpointing,
    enableMcpDiscovery = true,
  } = options;

  // Determine settingSources based on MCP discovery option
  const settingSources: SettingSource[] = enableMcpDiscovery ? ["project"] : [];

  return {
    prompt: scenario.user_prompt,
    options: {
      plugins,
      settingSources,
      allowedTools,
      ...(disallowedTools ? { disallowedTools } : {}),
      model,
      maxTurns,
      persistSession: true,
      continue: !isFirst,
      ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
      ...(enableFileCheckpointing ? { enableFileCheckpointing } : {}),
      abortSignal,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      hooks: {
        PreToolUse: [
          {
            matcher: ".*",
            hooks: [
              async (
                input,
                toolUseId,
                _context,
              ): Promise<Record<string, unknown>> => {
                if ("tool_name" in input && "tool_input" in input) {
                  const capture: ToolCapture = {
                    name: input.tool_name,
                    input: input.tool_input,
                    toolUseId,
                    timestamp: Date.now(),
                  };
                  onToolCapture(capture);

                  // Store in map for Post hook correlation
                  if (toolUseId) {
                    captureMap.set(toolUseId, capture);
                  }
                }
                return Promise.resolve({});
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: ".*",
            hooks: [
              async (
                input,
                toolUseId,
                _context,
              ): Promise<Record<string, unknown>> => {
                // PostToolUse hooks receive PostToolUseHookInput with tool_response
                if (toolUseId && captureMap.has(toolUseId)) {
                  const capture = captureMap.get(toolUseId);
                  if (capture && "tool_response" in input) {
                    capture.result = input.tool_response;
                    capture.success = true;
                  }
                }
                return Promise.resolve({});
              },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            matcher: ".*",
            hooks: [
              async (
                input,
                toolUseId,
                _context,
              ): Promise<Record<string, unknown>> => {
                // PostToolUseFailure hooks receive PostToolUseFailureHookInput with error
                if (toolUseId && captureMap.has(toolUseId)) {
                  const capture = captureMap.get(toolUseId);
                  if (capture && "error" in input) {
                    // TypeScript narrows to PostToolUseFailureHookInput after "error" in input check
                    capture.error = input.error;
                    capture.success = false;
                    if (input.is_interrupt !== undefined) {
                      capture.isInterrupt = input.is_interrupt;
                    }
                  }
                }
                return Promise.resolve({});
              },
            ],
          },
        ],
      },
      stderr: onStderr,
    },
  };
}

/**
 * Options for sending a clear command.
 */
interface SendClearCommandOptions {
  /** Plugin references */
  plugins: PluginReference[];
  /** Tools to allow */
  allowedTools: string[];
  /** Model to use */
  model: string;
  /** Abort signal */
  abortSignal: AbortSignal;
  /** Query function (for testing) */
  queryFn?: QueryFunction | undefined;
  /** Enable MCP server discovery via settingSources */
  enableMcpDiscovery?: boolean | undefined;
}

/**
 * Send /clear command to reset the conversation between scenarios.
 *
 * @param options - Clear command options
 */
async function sendClearCommand(
  options: SendClearCommandOptions,
): Promise<void> {
  const {
    plugins,
    allowedTools,
    model,
    abortSignal,
    queryFn,
    enableMcpDiscovery = true,
  } = options;

  // Determine settingSources based on MCP discovery option
  const settingSources: SettingSource[] = enableMcpDiscovery ? ["project"] : [];

  logger.debug("Batch: sending /clear to reset conversation");

  const clearQueryInput: QueryInput = {
    prompt: "/clear",
    options: {
      plugins,
      settingSources,
      allowedTools,
      model,
      maxTurns: 1,
      persistSession: true,
      continue: true,
      abortSignal,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  };

  const clearQuery = queryFn
    ? queryFn(clearQueryInput)
    : executeQuery(clearQueryInput);

  for await (const _message of clearQuery) {
    // Just consume
  }

  logger.debug("Batch: conversation reset complete");
}

/**
 * Rewind file changes after scenario execution.
 *
 * @param queryObject - The query object with rewindFiles method
 * @param userMessageId - The user message ID to rewind to
 * @param scenarioId - The scenario ID for logging
 */
async function rewindFileChanges(
  queryObject: { rewindFiles?: (messageId: string) => Promise<void> },
  userMessageId: string,
  scenarioId: string,
): Promise<void> {
  if (typeof queryObject.rewindFiles !== "function") {
    logger.debug(
      `Batch: rewindFiles not available for ${scenarioId}, skipping checkpoint`,
    );
    return;
  }

  try {
    await queryObject.rewindFiles(userMessageId);
    logger.debug(`Batch: reverted file changes for scenario: ${scenarioId}`);
  } catch (rewindErr) {
    logger.warn(
      `Batch: failed to rewind files for ${scenarioId}: ${rewindErr instanceof Error ? rewindErr.message : String(rewindErr)}`,
    );
  }
}

/**
 * Execute a batch of scenarios with session reuse.
 *
 * Uses `persistSession: true` for the first scenario, then `continue: true`
 * with /clear between subsequent scenarios to reuse the same session.
 *
 * This reduces subprocess spawn overhead from ~5s per scenario to ~5s per batch.
 *
 * @param options - Batch execution options
 * @returns Array of execution results
 */
export async function executeBatch(
  options: BatchExecutionOptions,
): Promise<ExecutionResult[]> {
  const {
    scenarios,
    pluginPath,
    pluginName,
    config,
    additionalPlugins = [],
    queryFn,
    onScenarioComplete,
    useCheckpointing = false,
  } = options;

  if (scenarios.length === 0) {
    return [];
  }

  const results: ExecutionResult[] = [];
  const startTime = Date.now();

  // Build plugin list
  const plugins: PluginReference[] = [{ type: "local", path: pluginPath }];
  for (const additionalPath of additionalPlugins) {
    plugins.push({ type: "local", path: additionalPath });
  }

  // Build allowed tools
  const allowedTools = [
    ...(config.allowed_tools ?? []),
    "Skill",
    "SlashCommand",
    "Task",
    "Read",
    "Glob",
    "Grep",
  ];

  // Process each scenario in the batch
  for (const scenario of scenarios) {
    const scenarioIndex = results.length;

    // Create abort controller for this scenario
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout_ms);

    try {
      // Execute scenario with retry support
      const executionResult = await executeScenarioWithRetry({
        scenario,
        scenarioIndex,
        totalScenarios: scenarios.length,
        plugins,
        allowedTools,
        config,
        useCheckpointing,
        enableMcpDiscovery: options.enableMcpDiscovery,
        controller,
        startTime,
        pluginName,
        queryFn,
      });

      // Build result for this scenario
      const result = buildScenarioResult(
        scenario,
        executionResult.messages,
        executionResult.detectedTools,
        executionResult.hookResponses,
        executionResult.errors,
        pluginName,
        config.model,
      );
      results.push(result);
      onScenarioComplete?.(result, scenarioIndex);

      logger.debug(
        `Batch: completed scenario ${String(scenarioIndex + 1)}/${String(scenarios.length)}`,
      );

      // Send /clear to reset conversation for next scenario (unless this is the last one)
      if (scenarioIndex < scenarios.length - 1) {
        await sendClearCommand({
          plugins,
          allowedTools,
          model: config.model,
          abortSignal: controller.signal,
          queryFn,
          enableMcpDiscovery: options.enableMcpDiscovery,
        });
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      const errorEvent: TranscriptErrorEvent = {
        type: "error",
        error_type: isTimeout ? "timeout" : "api_error",
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
        recoverable: false,
      };

      // Build result with error (empty messages/tools since execution failed)
      const result = buildScenarioResult(
        scenario,
        [],
        [],
        [],
        [errorEvent],
        pluginName,
        config.model,
      );
      results.push(result);
      onScenarioComplete?.(result, scenarioIndex);

      logger.warn(
        `Batch: scenario ${String(scenarioIndex + 1)} failed, continuing with batch: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  const duration = Date.now() - startTime;
  logger.debug(
    `Batch complete: ${String(results.length)} scenarios in ${String(duration)}ms`,
  );

  return results;
}

/**
 * Build an execution result for a scenario.
 */
function buildScenarioResult(
  scenario: TestScenario,
  messages: SDKMessage[],
  detectedTools: ToolCapture[],
  hookResponses: ReturnType<typeof createHookResponseCollector>["responses"],
  errors: TranscriptErrorEvent[],
  pluginName: string,
  model: string,
): ExecutionResult {
  // Extract metrics from result message
  const resultMsg = messages.find(isResultMessage);
  const costUsd = resultMsg?.total_cost_usd ?? 0;
  const durationMs = resultMsg?.duration_ms ?? 0;
  const numTurns = resultMsg?.num_turns ?? 0;
  const permissionDenials = resultMsg?.permission_denials ?? [];

  // Build transcript
  const context: TranscriptBuilderContext = {
    scenario,
    pluginName,
    model,
  };

  return {
    scenario_id: scenario.id,
    transcript: buildTranscript(context, messages, errors),
    detected_tools: detectedTools,
    hook_responses: hookResponses,
    cost_usd: costUsd,
    api_duration_ms: durationMs,
    num_turns: numTurns,
    permission_denials: permissionDenials,
    errors,
  };
}

/**
 * Log batch execution statistics.
 */
export function logBatchStats(
  groups: Map<string, TestScenario[]>,
  totalScenarios: number,
): void {
  const numGroups = groups.size;
  const avgPerGroup = totalScenarios / numGroups;

  logger.info(
    `Session batching: ${String(totalScenarios)} scenarios in ${String(numGroups)} groups ` +
      `(avg ${avgPerGroup.toFixed(1)} per group)`,
  );

  // Log overhead savings estimate
  const isolatedOverheadSec = totalScenarios * 5; // ~5s per scenario
  const batchedOverheadSec = numGroups * 5; // ~5s per batch
  const savingsPct = (
    ((isolatedOverheadSec - batchedOverheadSec) / isolatedOverheadSec) *
    100
  ).toFixed(0);

  logger.info(
    `Estimated overhead reduction: ${String(isolatedOverheadSec)}s -> ${String(batchedOverheadSec)}s (${savingsPct}% savings)`,
  );
}
