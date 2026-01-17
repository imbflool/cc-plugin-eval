/**
 * Agent SDK client for Stage 3: Execution.
 *
 * This module provides the integration with @anthropic-ai/claude-agent-sdk
 * for executing scenarios with plugins loaded.
 */

import {
  query,
  type HookCallback as SDKHookCallback,
  type HookCallbackMatcher,
  type PreToolUseHookInput as SDKPreToolUseHookInput,
  type PostToolUseHookInput as SDKPostToolUseHookInput,
  type PostToolUseFailureHookInput as SDKPostToolUseFailureHookInput,
  type SubagentStartHookInput as SDKSubagentStartHookInput,
  type SubagentStopHookInput as SDKSubagentStopHookInput,
  type PermissionMode,
  type SettingSource,
  type SDKUserMessage as SDKUserMessageType,
  // Import SDK message types directly
  type SDKMessage as SDKMessageType,
  type SDKAssistantMessage as SDKAssistantMessageType,
  type SDKResultMessage as SDKResultMessageType,
  type SDKResultSuccess,
  type SDKResultError,
  type SDKSystemMessage as SDKSystemMessageType,
  type SDKPermissionDenial,
} from "@anthropic-ai/claude-agent-sdk";

// Import types from the types layer
import type { ModelUsage } from "../../types/transcript.js";

// Re-export types for use in other modules
export type { PermissionMode, SettingSource, ModelUsage };

// Re-export the query function for use throughout Stage 3
export { query };

// Re-export SDK types directly
export type SDKUserMessage = SDKUserMessageType;
export type SDKMessage = SDKMessageType;
export type SDKAssistantMessage = SDKAssistantMessageType;
export type SDKResultMessage = SDKResultMessageType;
export type SDKSystemMessage = SDKSystemMessageType;
export type { SDKResultSuccess, SDKResultError, SDKPermissionDenial };

/**
 * SDK tool result message.
 * Note: This type is not directly exported by the SDK, so we define it here
 * based on the expected structure.
 */
export interface SDKToolResultMessage {
  type: "tool_result";
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

/**
 * SDK error message.
 * Note: This type is not directly exported by the SDK, so we define it here
 * based on the expected structure.
 */
export interface SDKErrorMessage {
  type: "error";
  error?: string;
}

/**
 * PreToolUse hook input from SDK.
 * Re-exported for use in other modules.
 */
export type PreToolUseHookInput = SDKPreToolUseHookInput;

/**
 * PostToolUse hook input from SDK.
 * Re-exported for use in other modules.
 */
export type PostToolUseHookInput = SDKPostToolUseHookInput;

/**
 * PostToolUseFailure hook input from SDK.
 * Re-exported for use in other modules.
 */
export type PostToolUseFailureHookInput = SDKPostToolUseFailureHookInput;

/**
 * SubagentStart hook input from SDK.
 * Fired when a subagent is spawned.
 * Re-exported for use in other modules.
 */
export type SubagentStartHookInput = SDKSubagentStartHookInput;

/**
 * SubagentStop hook input from SDK.
 * Fired when a subagent completes.
 * Re-exported for use in other modules.
 */
export type SubagentStopHookInput = SDKSubagentStopHookInput;

/**
 * Hook JSON output - return value from hooks.
 */
export interface HookJSONOutput {
  decision?: "allow" | "deny";
  reason?: string;
}

/**
 * Hook callback signature matching Agent SDK.
 * Re-exported for use in other modules.
 */
export type HookCallback = SDKHookCallback;

/**
 * Hook configuration for PreToolUse.
 * Uses SDK's HookCallbackMatcher type.
 */
export type PreToolUseHookConfig = HookCallbackMatcher;

/**
 * Hook configuration for PostToolUse.
 * Uses SDK's HookCallbackMatcher type.
 */
export type PostToolUseHookConfig = HookCallbackMatcher;

/**
 * Hook configuration for PostToolUseFailure.
 * Uses SDK's HookCallbackMatcher type.
 */
export type PostToolUseFailureHookConfig = HookCallbackMatcher;

/**
 * Hook configuration for SubagentStart.
 * Uses SDK's HookCallbackMatcher type.
 */
export type SubagentStartHookConfig = HookCallbackMatcher;

/**
 * Hook configuration for SubagentStop.
 * Uses SDK's HookCallbackMatcher type.
 */
export type SubagentStopHookConfig = HookCallbackMatcher;

/**
 * Plugin reference for SDK options.
 */
export interface PluginReference {
  type: "local";
  path: string;
}

/**
 * System prompt configuration type.
 * Can be a raw string or a preset configuration object.
 */
export type SystemPromptConfig =
  | string
  | {
      type: "preset";
      preset: "claude_code";
      append?: string;
    };

/**
 * Query options for the Agent SDK.
 */
export interface QueryOptions {
  plugins?: PluginReference[];
  settingSources?: SettingSource[];
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  /** System prompt configuration. Use Claude Code preset for plugin evaluation. */
  systemPrompt?: SystemPromptConfig;
  maxTurns?: number;
  persistSession?: boolean;
  continue?: boolean;
  maxBudgetUsd?: number;
  abortController?: AbortController;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  enableFileCheckpointing?: boolean;
  /** Limit extended thinking tokens to reduce cost. */
  maxThinkingTokens?: number;
  hooks?: {
    PreToolUse?: HookCallbackMatcher[];
    PostToolUse?: HookCallbackMatcher[];
    PostToolUseFailure?: HookCallbackMatcher[];
    SubagentStart?: HookCallbackMatcher[];
    SubagentStop?: HookCallbackMatcher[];
  };
  stderr?: (data: string) => void;
}

/**
 * Query input for the SDK.
 */
export interface QueryInput {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: QueryOptions;
}

/**
 * The Query object returned by query() - provides iteration and methods.
 * This is an async iterable that also has methods like rewindFiles().
 */
export interface QueryObject extends AsyncIterable<SDKMessage> {
  /**
   * Rewind files to state before a given message.
   * Only available when enableFileCheckpointing is true.
   */
  rewindFiles?(messageId: string): Promise<void>;

  /**
   * Get supported slash commands.
   */
  supportedCommands?(): Promise<string[]>;

  /**
   * Get MCP server status.
   */
  mcpServerStatus?(): Promise<
    Record<string, { status: string; tools: string[] }>
  >;

  /**
   * Get account info.
   */
  accountInfo?(): Promise<{ tier: string }>;
}

/**
 * Type guard for user message.
 */
export function isUserMessage(msg: SDKMessage): msg is SDKUserMessage {
  return msg.type === "user" && typeof msg.message === "object";
}

/**
 * Type guard for assistant message.
 */
export function isAssistantMessage(
  msg: SDKMessage,
): msg is SDKAssistantMessage {
  return msg.type === "assistant" && typeof msg.message === "object";
}

/**
 * Type guard for tool result message.
 * Note: This message type is not part of SDK's SDKMessage union,
 * but may appear in the message stream.
 */
export function isToolResultMessage(msg: unknown): msg is SDKToolResultMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: string }).type === "tool_result" &&
    typeof (msg as { tool_use_id?: string }).tool_use_id === "string"
  );
}

/**
 * Type guard for result message.
 */
export function isResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

/**
 * Type guard for successful result message.
 *
 * @example
 * ```typescript
 * if (isResultMessage(msg) && isResultSuccess(msg)) {
 *   console.log(msg.result); // Access success-specific fields
 * }
 * ```
 */
export function isResultSuccess(
  msg: SDKResultMessage,
): msg is SDKResultSuccess {
  return msg.subtype === "success";
}

/**
 * Type guard for error result message.
 *
 * @example
 * ```typescript
 * if (isResultMessage(msg) && isResultError(msg)) {
 *   console.error(msg.errors); // Access error-specific fields
 * }
 * ```
 */
export function isResultError(msg: SDKResultMessage): msg is SDKResultError {
  return msg.subtype !== "success";
}

/**
 * Type guard for system message.
 */
export function isSystemMessage(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === "system";
}

/**
 * Type guard for error message.
 * Note: This message type is not part of SDK's SDKMessage union,
 * but may appear in the message stream.
 */
export function isErrorMessage(msg: unknown): msg is SDKErrorMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as { type?: string }).type === "error"
  );
}

/**
 * Execute a query using the Agent SDK.
 *
 * This is a thin wrapper around the SDK's query function that returns
 * the Query object for both iteration and method access.
 *
 * @param input - Query input with prompt and options
 * @returns Query object for async iteration and methods
 */
export function executeQuery(input: QueryInput): QueryObject {
  // The SDK's query() returns an async iterable that may also have methods
  // Cast to our QueryObject interface which extends AsyncIterable
  return query(input) as unknown as QueryObject;
}

/**
 * Collect all messages from a query execution.
 *
 * @param input - Query input
 * @returns Array of all messages
 */
export async function collectQueryMessages(
  input: QueryInput,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  const q = executeQuery(input);

  for await (const message of q) {
    messages.push(message);
  }

  return messages;
}
