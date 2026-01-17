/**
 * Mock SDK factory for Stage 3 integration tests.
 *
 * Provides mock implementations of the Agent SDK query function
 * to enable deterministic testing without real API calls.
 */

import type {
  QueryFunction,
  ScenarioExecutionOptions,
} from "../../src/stages/3-execution/agent-executor.js";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKErrorMessage,
  SDKToolResultMessage,
  SDKPermissionDenial,
  QueryObject,
  QueryInput,
  PreToolUseHookConfig,
  SubagentStartHookConfig,
  SubagentStopHookConfig,
} from "../../src/stages/3-execution/sdk-client.js";
import type { ToolCapture, ExecutionConfig } from "../../src/types/index.js";

/**
 * Tool invocation configuration for mock responses.
 */
export interface MockToolCall {
  name: string;
  input: unknown;
  id?: string;
}

/**
 * Subagent spawn configuration for mock responses.
 */
export interface MockSubagentSpawn {
  agentId: string;
  agentType: string;
}

/**
 * Configuration for creating mock query functions.
 */
export interface MockQueryConfig {
  /** Tool calls to simulate in assistant response */
  triggeredTools?: MockToolCall[];

  /** Subagent spawns to simulate (triggers SubagentStart/SubagentStop hooks) */
  subagentSpawns?: MockSubagentSpawn[];

  /** Error message to simulate (makes execution fail) */
  errorMessage?: string;

  /** Whether to simulate a timeout via AbortSignal */
  shouldTimeout?: boolean;

  /** Cost in USD to report */
  costUsd?: number;

  /** Duration in ms to report */
  durationMs?: number;

  /** Number of turns to report */
  numTurns?: number;

  /** Permission denials to report */
  permissionDenials?: SDKPermissionDenial[];

  /** Custom messages to inject */
  customMessages?: SDKMessage[];

  /** Plugins to report as loaded */
  loadedPlugins?: Array<{ name: string; path: string }>;

  /** MCP servers to report */
  mcpServers?: Array<{ name: string; status: string; error?: string }>;

  /** Available tools to report */
  availableTools?: string[];

  /** Available slash commands to report */
  slashCommands?: string[];

  /** Session ID to use */
  sessionId?: string;

  /** User message ID for rewind testing */
  userMessageId?: string;

  /** Tool results to inject after tool calls */
  toolResults?: Array<{
    toolUseId: string;
    content: string;
    isError?: boolean;
  }>;

  /** Whether rewindFiles should throw */
  rewindFilesError?: string;
}

/**
 * Default mock configuration values.
 */
const MOCK_DEFAULTS: Required<
  Pick<
    MockQueryConfig,
    | "costUsd"
    | "durationMs"
    | "numTurns"
    | "sessionId"
    | "availableTools"
    | "slashCommands"
  >
> = {
  costUsd: 0.01,
  durationMs: 1000,
  numTurns: 2,
  sessionId: "mock-session-123",
  availableTools: ["Skill", "Task", "SlashCommand", "Read", "Glob", "Grep"],
  slashCommands: ["/commit", "/review-pr"],
};

/**
 * Create a mock query function for testing.
 *
 * Returns a QueryFunction that yields predetermined SDK messages
 * based on the configuration provided. This mock also calls
 * PreToolUse hooks to simulate tool capture.
 *
 * @param config - Mock configuration
 * @returns QueryFunction suitable for dependency injection
 *
 * @example
 * ```typescript
 * const mockQuery = createMockQueryFn({
 *   triggeredTools: [{ name: 'Skill', input: { skill: 'commit' } }],
 *   costUsd: 0.005,
 * });
 *
 * const result = await executeScenario({
 *   scenario,
 *   pluginPath,
 *   pluginName,
 *   config,
 *   queryFn: mockQuery,
 * });
 * ```
 */
export function createMockQueryFn(config: MockQueryConfig = {}): QueryFunction {
  return (input: QueryInput): QueryObject => {
    const messages: SDKMessage[] = [];
    let toolCallCounter = 0;

    // Extract hooks for calling during tool use
    const preToolUseHooks: PreToolUseHookConfig[] =
      input.options?.hooks?.PreToolUse ?? [];
    const subagentStartHooks: SubagentStartHookConfig[] =
      input.options?.hooks?.SubagentStart ?? [];
    const subagentStopHooks: SubagentStopHookConfig[] =
      input.options?.hooks?.SubagentStop ?? [];

    // Build tool calls with IDs
    const toolCalls =
      config.triggeredTools?.map((t) => ({
        type: "tool_use" as const,
        id: t.id ?? `tool-use-${++toolCallCounter}`,
        name: t.name,
        input: t.input,
      })) ?? [];

    // 1. System init message
    const systemMsg: SDKSystemMessage = {
      type: "system",
      subtype: "init",
      session_id: config.sessionId ?? MOCK_DEFAULTS.sessionId,
      tools: config.availableTools ?? MOCK_DEFAULTS.availableTools,
      slash_commands: config.slashCommands ?? MOCK_DEFAULTS.slashCommands,
      plugins:
        config.loadedPlugins ??
        (input.options?.plugins?.map((p) => ({
          name: "test-plugin",
          path: p.path,
        })) ||
          []),
      ...(config.mcpServers ? { mcp_servers: config.mcpServers } : {}),
    };
    messages.push(systemMsg);

    // 2. User message
    const userMsg: SDKUserMessage = {
      type: "user",
      id: config.userMessageId ?? `user-msg-${Date.now()}`,
      message: {
        role: "user",
        content: input.prompt,
      },
    };
    messages.push(userMsg);

    // 3. Handle error case
    if (config.errorMessage) {
      const errorMsg: SDKErrorMessage = {
        type: "error",
        error: config.errorMessage,
      };
      messages.push(errorMsg);
    } else {
      // 4. Assistant message with tool calls
      const assistantMsg: SDKAssistantMessage = {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll help with that." },
            ...toolCalls,
          ],
        },
      };
      messages.push(assistantMsg);

      // 5. Tool results (if provided)
      if (config.toolResults) {
        for (const result of config.toolResults) {
          const toolResultMsg: SDKToolResultMessage = {
            type: "tool_result",
            tool_use_id: result.toolUseId,
            content: result.content,
            is_error: result.isError,
          };
          messages.push(toolResultMsg);
        }
      }
    }

    // Add custom messages
    if (config.customMessages) {
      messages.push(...config.customMessages);
    }

    // 6. Result message (matches SDKResultSuccess structure)
    const resultMsg = {
      type: "result" as const,
      subtype: "success" as const,
      total_cost_usd: config.costUsd ?? MOCK_DEFAULTS.costUsd,
      duration_ms: config.durationMs ?? MOCK_DEFAULTS.durationMs,
      duration_api_ms: config.durationMs ?? MOCK_DEFAULTS.durationMs,
      is_error: false,
      num_turns: config.numTurns ?? MOCK_DEFAULTS.numTurns,
      result: "Mock execution completed",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: config.permissionDenials ?? [],
      uuid: `mock-uuid-${Date.now()}` as `${string}-${string}-${string}-${string}-${string}`,
      session_id: config.sessionId ?? MOCK_DEFAULTS.sessionId,
    } satisfies SDKResultMessage;
    messages.push(resultMsg);

    // Helper to call PreToolUse hooks for a tool
    const callHooksForTool = async (
      toolName: string,
      toolInput: unknown,
      toolUseId: string,
    ) => {
      for (const hookConfig of preToolUseHooks) {
        // Check if matcher matches the tool name
        const matcher = new RegExp(hookConfig.matcher);
        if (matcher.test(toolName)) {
          // Call each hook in the config
          for (const hook of hookConfig.hooks) {
            await hook(
              { tool_name: toolName, tool_input: toolInput },
              toolUseId,
              {
                signal:
                  input.options?.abortController?.signal ??
                  new AbortController().signal,
              },
            );
          }
        }
      }
    };

    // Helper to call SubagentStart hooks for an agent
    const callSubagentStartHooks = async (
      agentId: string,
      agentType: string,
    ) => {
      for (const hookConfig of subagentStartHooks) {
        const matcher = new RegExp(hookConfig.matcher);
        if (matcher.test(agentType)) {
          for (const hook of hookConfig.hooks) {
            await hook(
              { agent_id: agentId, agent_type: agentType },
              `subagent-start-${agentId}`,
              {
                signal:
                  input.options?.abortController?.signal ??
                  new AbortController().signal,
              },
            );
          }
        }
      }
    };

    // Helper to call SubagentStop hooks for an agent
    const callSubagentStopHooks = async (agentId: string) => {
      for (const hookConfig of subagentStopHooks) {
        const matcher = new RegExp(hookConfig.matcher);
        // SubagentStop matcher typically matches on agent_id
        if (matcher.test(agentId) || hookConfig.matcher === ".*") {
          for (const hook of hookConfig.hooks) {
            await hook({ agent_id: agentId }, `subagent-stop-${agentId}`, {
              signal:
                input.options?.abortController?.signal ??
                new AbortController().signal,
            });
          }
        }
      }
    };

    // Create QueryObject with async iterator
    const queryObject: QueryObject = {
      [Symbol.asyncIterator]: async function* () {
        for (const msg of messages) {
          // Simulate timeout if requested
          if (config.shouldTimeout) {
            // Check if signal is already aborted
            if (input.options?.abortController?.signal.aborted) {
              const error = new Error("Operation aborted");
              error.name = "AbortError";
              throw error;
            }
          }

          // Call hooks before yielding assistant message with tool calls
          if (msg.type === "assistant" && !config.errorMessage) {
            for (const toolCall of toolCalls) {
              await callHooksForTool(
                toolCall.name,
                toolCall.input,
                toolCall.id,
              );
            }

            // Simulate subagent spawns (both start and stop)
            if (config.subagentSpawns) {
              for (const spawn of config.subagentSpawns) {
                await callSubagentStartHooks(spawn.agentId, spawn.agentType);
                await callSubagentStopHooks(spawn.agentId);
              }
            }
          }

          yield msg;
        }
      },

      rewindFiles: async (_messageId: string) => {
        if (config.rewindFilesError) {
          throw new Error(config.rewindFilesError);
        }
        // No-op for mock
      },

      supportedCommands: async () =>
        config.slashCommands ?? MOCK_DEFAULTS.slashCommands,

      mcpServerStatus: async () => {
        const status: Record<string, { status: string; tools: string[] }> = {};
        if (config.mcpServers) {
          for (const server of config.mcpServers) {
            status[server.name] = { status: server.status, tools: [] };
          }
        }
        return status;
      },

      accountInfo: async () => ({ tier: "free" }),
    };

    return queryObject;
  };
}

/**
 * Create a mock tool capture.
 *
 * Helper for creating ToolCapture objects in tests.
 *
 * @param toolName - Name of the tool
 * @param input - Tool input
 * @param toolUseId - Optional tool use ID
 * @returns ToolCapture object
 */
export function createMockToolCapture(
  toolName: string,
  input: unknown,
  toolUseId?: string,
): ToolCapture {
  return {
    name: toolName,
    input,
    toolUseId: toolUseId ?? `mock-tool-${Date.now()}`,
    timestamp: Date.now(),
  };
}

/**
 * Create a mock execution config for testing.
 *
 * @param overrides - Partial config to override defaults
 * @returns ExecutionConfig
 */
export function createMockExecutionConfig(
  overrides: Partial<ExecutionConfig> = {},
): ExecutionConfig {
  return {
    model: "claude-sonnet-4-20250514",
    max_turns: 3,
    timeout_ms: 30000,
    max_budget_usd: 1.0,
    session_isolation: true,
    permission_bypass: true,
    num_reps: 1,
    additional_plugins: [],
    ...overrides,
  };
}

/**
 * Create mock scenario execution options.
 *
 * @param overrides - Partial options to override defaults
 * @returns ScenarioExecutionOptions
 */
export function createMockScenarioOptions(
  overrides: Partial<ScenarioExecutionOptions> = {},
): ScenarioExecutionOptions {
  return {
    scenario: {
      id: "test-scenario-1",
      component_ref: "test-skill",
      component_type: "skill",
      scenario_type: "direct",
      user_prompt: "Test prompt",
      expected_trigger: true,
      expected_component: "test-skill",
    },
    pluginPath: "/path/to/plugin",
    pluginName: "test-plugin",
    config: createMockExecutionConfig(),
    ...overrides,
  };
}

/**
 * Create a mock query function that throws an error.
 *
 * @param errorMessage - Error message
 * @returns QueryFunction that throws
 */
export function createThrowingQueryFn(errorMessage: string): QueryFunction {
  return (_input: QueryInput): QueryObject => {
    return {
      [Symbol.asyncIterator]: async function* () {
        throw new Error(errorMessage);
      },
      rewindFiles: async () => {},
      supportedCommands: async () => [],
    } as QueryObject;
  };
}

/**
 * Create a mock query function that simulates timeout.
 *
 * @param delayMs - Delay before yielding (default: never yields)
 * @returns QueryFunction that hangs or yields after delay
 */
export function createTimeoutQueryFn(delayMs?: number): QueryFunction {
  return (input: QueryInput): QueryObject => {
    return {
      [Symbol.asyncIterator]: async function* () {
        // If abort controller is provided, wait for it to abort
        if (input.options?.abortController) {
          if (delayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }

          // Check if aborted
          if (input.options.abortController.signal.aborted) {
            const error = new Error("Operation aborted");
            error.name = "AbortError";
            throw error;
          }

          // If not aborted and delay passed, yield messages
          const systemMsg: SDKSystemMessage = {
            type: "system",
            subtype: "init",
            session_id: "timeout-test",
            tools: [],
            slash_commands: [],
            plugins: [],
          };
          yield systemMsg;
        }
      },
      rewindFiles: async () => {},
      supportedCommands: async () => [],
    } as QueryObject;
  };
}
