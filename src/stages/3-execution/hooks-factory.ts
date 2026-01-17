/**
 * Factory for creating SDK hook configurations used in scenario execution.
 *
 * This module centralizes the creation of capture hooks for tool and subagent tracking,
 * ensuring consistency between agent-executor.ts and session-batching.ts.
 *
 * @module hooks-factory
 */

import {
  createPreToolUseHook,
  createPostToolUseHook,
  createPostToolUseFailureHook,
  createSubagentStartHook,
  createSubagentStopHook,
  type OnToolCapture,
  type OnSubagentCapture,
} from "./tool-capture-hooks.js";

import type {
  HookCallback,
  PreToolUseHookConfig,
  PostToolUseHookConfig,
  PostToolUseFailureHookConfig,
  SubagentStartHookConfig,
  SubagentStopHookConfig,
} from "./sdk-client.js";
import type { ToolCapture, SubagentCapture } from "../../types/index.js";

/**
 * SDK-compatible hooks configuration with PascalCase event type keys.
 * This matches the format expected by the Agent SDK's query options.
 */
export interface SDKHooksConfig {
  PreToolUse: PreToolUseHookConfig[];
  PostToolUse: PostToolUseHookConfig[];
  PostToolUseFailure: PostToolUseFailureHookConfig[];
  SubagentStart: SubagentStartHookConfig[];
  SubagentStop: SubagentStopHookConfig[];
}

/**
 * Options for creating capture hooks configuration.
 */
export interface CaptureHooksOptions {
  /** Map for correlating PreToolUse with PostToolUse/PostToolUseFailure events */
  captureMap: Map<string, ToolCapture>;
  /** Callback invoked when a tool is captured */
  onToolCapture: OnToolCapture;
  /** Map for correlating SubagentStart with SubagentStop events */
  subagentCaptureMap: Map<string, SubagentCapture>;
  /** Callback invoked when a subagent is captured */
  onSubagentCapture: OnSubagentCapture;
}

/**
 * Stateless hooks that only read/write to capture maps.
 * These can be reused across multiple scenarios in a batch.
 */
export interface StatelessHooks {
  /** PostToolUse hook for updating captures with success results */
  postToolUseHook: HookCallback;
  /** PostToolUseFailure hook for updating captures with error results */
  postToolUseFailureHook: HookCallback;
  /** SubagentStop hook for updating subagent captures with stop information */
  subagentStopHook: HookCallback;
}

/**
 * Options for creating stateless hooks that can be reused across scenarios.
 */
export interface StatelessHooksOptions {
  /** Map for correlating PreToolUse with PostToolUse/PostToolUseFailure events */
  captureMap: Map<string, ToolCapture>;
  /** Map for correlating SubagentStart with SubagentStop events */
  subagentCaptureMap: Map<string, SubagentCapture>;
}

/**
 * Stateful hooks that have closures over per-scenario callbacks.
 * These must be created fresh for each scenario to ensure capture isolation.
 */
export interface StatefulHooks {
  /** PreToolUse hook with scenario-specific onToolCapture callback */
  preToolUseHook: HookCallback;
  /** SubagentStart hook with scenario-specific onSubagentCapture callback */
  subagentStartHook: HookCallback;
}

/**
 * Options for creating stateful hooks with per-scenario callbacks.
 */
export interface StatefulHooksOptions {
  /** Map for storing captures (shared from batch) */
  captureMap: Map<string, ToolCapture>;
  /** Per-scenario callback for tool captures */
  onToolCapture: OnToolCapture;
  /** Map for storing subagent captures (shared from batch) */
  subagentCaptureMap: Map<string, SubagentCapture>;
  /** Per-scenario callback for subagent captures */
  onSubagentCapture: OnSubagentCapture;
}

/**
 * Creates stateless hooks that can be reused across multiple scenarios in a batch.
 *
 * These hooks (PostToolUse, PostToolUseFailure, SubagentStop) only read/write to
 * the capture maps and don't have closures over scenario-specific callbacks.
 * This reduces memory allocations when executing batched scenarios.
 *
 * @param options - Options containing the capture maps
 * @returns Stateless hooks that can be reused across scenarios
 *
 * @example
 * ```typescript
 * const captureMap = new Map<string, ToolCapture>();
 * const subagentCaptureMap = new Map<string, SubagentCapture>();
 *
 * // Create once per batch
 * const statelessHooks = createBatchStatelessHooks({ captureMap, subagentCaptureMap });
 *
 * for (const scenario of scenarios) {
 *   // Clear maps between scenarios
 *   captureMap.clear();
 *   subagentCaptureMap.clear();
 *
 *   // Use statelessHooks in query input...
 * }
 * ```
 */
export function createBatchStatelessHooks(
  options: StatelessHooksOptions,
): StatelessHooks {
  const { captureMap, subagentCaptureMap } = options;

  return {
    postToolUseHook: createPostToolUseHook(captureMap),
    postToolUseFailureHook: createPostToolUseFailureHook(captureMap),
    subagentStopHook: createSubagentStopHook(subagentCaptureMap),
  };
}

/**
 * Creates stateful hooks with per-scenario callbacks.
 *
 * These hooks (PreToolUse, SubagentStart) have closures over callback functions
 * that push to scenario-specific arrays. They must be created fresh for each
 * scenario to ensure proper capture isolation.
 *
 * @param options - Options containing maps and per-scenario callbacks
 * @returns Stateful hooks for a single scenario
 *
 * @example
 * ```typescript
 * for (const scenario of scenarios) {
 *   const detectedTools: ToolCapture[] = [];
 *   const subagentCaptures: SubagentCapture[] = [];
 *
 *   // Create fresh hooks for each scenario
 *   const statefulHooks = createScenarioStatefulHooks({
 *     captureMap,
 *     onToolCapture: (c) => detectedTools.push(c),
 *     subagentCaptureMap,
 *     onSubagentCapture: (c) => subagentCaptures.push(c),
 *   });
 *
 *   // Execute scenario with these hooks...
 * }
 * ```
 */
export function createScenarioStatefulHooks(
  options: StatefulHooksOptions,
): StatefulHooks {
  const { captureMap, onToolCapture, subagentCaptureMap, onSubagentCapture } =
    options;

  return {
    preToolUseHook: createPreToolUseHook(captureMap, onToolCapture),
    subagentStartHook: createSubagentStartHook(
      subagentCaptureMap,
      onSubagentCapture,
    ),
  };
}

/**
 * Assembles an SDK-compatible hooks configuration from stateless and stateful hooks.
 *
 * This combines pre-created batch-level stateless hooks with scenario-specific
 * stateful hooks into the format expected by the Agent SDK.
 *
 * @param statelessHooks - Hooks reused across the batch
 * @param statefulHooks - Hooks specific to this scenario
 * @returns SDK-compatible hooks configuration
 */
export function assembleHooksConfig(
  statelessHooks: StatelessHooks,
  statefulHooks: StatefulHooks,
): SDKHooksConfig {
  return {
    PreToolUse: [
      {
        matcher: ".*",
        hooks: [statefulHooks.preToolUseHook],
      },
    ],
    PostToolUse: [
      {
        matcher: ".*",
        hooks: [statelessHooks.postToolUseHook],
      },
    ],
    PostToolUseFailure: [
      {
        matcher: ".*",
        hooks: [statelessHooks.postToolUseFailureHook],
      },
    ],
    SubagentStart: [
      {
        matcher: ".*",
        hooks: [statefulHooks.subagentStartHook],
      },
    ],
    SubagentStop: [
      {
        matcher: ".*",
        hooks: [statelessHooks.subagentStopHook],
      },
    ],
  };
}

/**
 * Creates an SDK-compatible hooks configuration for capturing tool and subagent invocations.
 *
 * This factory centralizes the hook setup that was previously duplicated in:
 * - agent-executor.ts (executeScenario, executeScenarioWithCheckpoint)
 * - session-batching.ts (buildScenarioQueryInput)
 *
 * All hooks use ".*" as the matcher to capture all tool invocations.
 *
 * @param options - Configuration options for the capture hooks
 * @returns SDK-compatible hooks configuration with PascalCase keys
 *
 * @example
 * ```typescript
 * const captureMap = new Map<string, ToolCapture>();
 * const subagentCaptureMap = new Map<string, SubagentCapture>();
 * const detectedTools: ToolCapture[] = [];
 * const subagentCaptures: SubagentCapture[] = [];
 *
 * const hooks = createCaptureHooksConfig({
 *   captureMap,
 *   onToolCapture: (capture) => detectedTools.push(capture),
 *   subagentCaptureMap,
 *   onSubagentCapture: (capture) => subagentCaptures.push(capture),
 * });
 *
 * const queryInput = {
 *   prompt: scenario.user_prompt,
 *   options: { hooks }
 * };
 * ```
 */
export function createCaptureHooksConfig(
  options: CaptureHooksOptions,
): SDKHooksConfig {
  const { captureMap, onToolCapture, subagentCaptureMap, onSubagentCapture } =
    options;

  return {
    PreToolUse: [
      {
        matcher: ".*",
        hooks: [createPreToolUseHook(captureMap, onToolCapture)],
      },
    ],
    PostToolUse: [
      {
        matcher: ".*",
        hooks: [createPostToolUseHook(captureMap)],
      },
    ],
    PostToolUseFailure: [
      {
        matcher: ".*",
        hooks: [createPostToolUseFailureHook(captureMap)],
      },
    ],
    SubagentStart: [
      {
        matcher: ".*",
        hooks: [createSubagentStartHook(subagentCaptureMap, onSubagentCapture)],
      },
    ],
    SubagentStop: [
      {
        matcher: ".*",
        hooks: [createSubagentStopHook(subagentCaptureMap)],
      },
    ],
  };
}
