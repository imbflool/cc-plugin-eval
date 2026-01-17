/**
 * Transcript type definitions.
 * Represents execution transcripts from Agent SDK runs.
 */

import type { SDKPermissionDenial } from "@anthropic-ai/claude-agent-sdk";

// Re-export for convenience
export type { SDKPermissionDenial };

/**
 * Per-model usage metrics from SDK.
 * Tracks token usage and costs for each model used in a scenario.
 * All fields are optional as the SDK may not provide all values.
 */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * Tool call captured during execution.
 */
export interface ToolCapture {
  name: string;
  input: unknown;
  toolUseId: string | undefined;
  timestamp: number;
  /** Tool execution result (from PostToolUse hook) */
  result?: unknown;
  /** Whether the tool executed successfully (undefined = not yet completed) */
  success?: boolean;
  /** Error message if the tool failed (from PostToolUseFailure hook) */
  error?: string;
  /** Whether the tool was interrupted */
  isInterrupt?: boolean;
}

/**
 * Subagent lifecycle event captured during execution.
 * Captured via SubagentStart and SubagentStop SDK hooks.
 */
export interface SubagentCapture {
  /** Agent ID from the SDK */
  agentId: string;
  /** Agent type (e.g., "Explore", "Bash", "general-purpose") */
  agentType: string;
  /** When the agent started */
  startTimestamp: number;
  /** When the agent completed (undefined if still running or not captured) */
  stopTimestamp?: number;
  /** Path to agent's transcript (from SubagentStop) */
  transcriptPath?: string;
  /** Whether stop hook was active (from SubagentStop) */
  stopHookActive?: boolean;
}

/**
 * Hook response captured during execution.
 * Corresponds to SDKHookResponseMessage from Agent SDK.
 */
export interface HookResponseCapture {
  /** Name of the hook that fired */
  hookName: string;
  /** Event type (PreToolUse, PostToolUse, Stop, etc.) */
  hookEvent: string;
  /** Hook stdout output */
  stdout: string;
  /** Hook stderr output */
  stderr: string;
  /** Exit code for command hooks */
  exitCode?: number | undefined;
  /** Capture timestamp */
  timestamp: number;
}

/**
 * Transcript metadata.
 */
export interface TranscriptMetadata {
  version: "v3.0";
  plugin_name: string;
  scenario_id: string;
  timestamp: string;
  model: string;
  total_cost_usd?: number;
  api_duration_ms?: number;
}

/**
 * User message event.
 */
export interface UserEvent {
  id: string;
  type: "user";
  edit: {
    message: {
      role: "user";
      content: string;
    };
  };
}

/**
 * Tool call in assistant message.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Assistant message event.
 */
export interface AssistantEvent {
  id: string;
  type: "assistant";
  edit: {
    message: {
      role: "assistant";
      content: string;
      tool_calls?: ToolCall[];
    };
  };
}

/**
 * Tool result event.
 */
export interface ToolResultEvent {
  id: string;
  type: "tool_result";
  tool_use_id: string;
  result: unknown;
  /** Whether the tool result represents an error */
  is_error?: boolean;
}

/**
 * Error event types.
 */
export type TranscriptErrorType =
  | "api_error"
  | "timeout"
  | "permission_denied"
  | "budget_exceeded";

/**
 * Error event in transcript.
 */
export interface TranscriptErrorEvent {
  type: "error";
  error_type: TranscriptErrorType;
  message: string;
  timestamp: number;
  recoverable: boolean;
  /** Anthropic SDK request ID for debugging with support */
  request_id?: string;
}

/**
 * Union of all event types.
 */
export type TranscriptEvent = UserEvent | AssistantEvent | ToolResultEvent;

/**
 * Complete transcript of an execution.
 */
export interface Transcript {
  metadata: TranscriptMetadata;
  events: TranscriptEvent[];
  errors?: TranscriptErrorEvent[];
}

/**
 * Result of executing a scenario.
 */
export interface ExecutionResult {
  scenario_id: string;
  transcript: Transcript;
  detected_tools: ToolCapture[];
  cost_usd: number;
  api_duration_ms: number;
  num_turns: number;
  /** Track hook denials */
  permission_denials: SDKPermissionDenial[];
  /** Track errors */
  errors: TranscriptErrorEvent[];
  /** Captured hook responses from SDK messages */
  hook_responses?: HookResponseCapture[];
  /** Subagent lifecycle events captured via SDK hooks */
  subagent_captures?: SubagentCapture[];
  /** Per-model usage breakdown (from SDK modelUsage) */
  model_usage?: Record<string, ModelUsage>;
  /** Total cache read tokens across all models */
  cache_read_tokens?: number;
  /** Total cache creation tokens across all models */
  cache_creation_tokens?: number;
}
