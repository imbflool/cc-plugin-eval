/**
 * Programmatic Detector - 100% confidence detection from tool captures.
 *
 * Primary detection method using real-time captures from PreToolUse hooks.
 * Success/failure status is determined via PostToolUse/PostToolUseFailure hooks.
 * Parses Skill, Task, SlashCommand, and MCP tool calls for deterministic
 * component identification.
 *
 * Detection priority:
 * 1. Real-time captures from PreToolUse hooks with success status (highest confidence)
 * 2. Direct command invocation in user message (/command syntax)
 * 3. Tool calls parsed from transcript (fallback)
 */

import { isMcpTool, parseMcpToolName } from "../3-execution/hook-capture.js";

import type {
  ComponentType,
  HookResponseCapture,
  ProgrammaticDetection,
  SubagentCapture,
  TestScenario,
  ToolCapture,
  Transcript,
} from "../../types/index.js";

/**
 * Skill tool input structure.
 */
interface SkillToolInput {
  skill: string;
  args?: string;
}

/**
 * Task tool input structure.
 */
interface TaskToolInput {
  subagent_type: string;
  prompt?: string;
  description?: string;
}

/**
 * Check if input is a Skill tool input.
 *
 * @param input - Tool input to check
 * @returns True if input matches Skill structure
 */
function isSkillInput(input: unknown): input is SkillToolInput {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  // Use intermediate Record<string, unknown> for safer property access
  const record = input as Record<string, unknown>;
  return "skill" in record && typeof record["skill"] === "string";
}

/**
 * Check if input is a Task tool input.
 *
 * @param input - Tool input to check
 * @returns True if input matches Task structure
 */
function isTaskInput(input: unknown): input is TaskToolInput {
  if (typeof input !== "object" || input === null) {
    return false;
  }
  // Use intermediate Record<string, unknown> for safer property access
  const record = input as Record<string, unknown>;
  return (
    "subagent_type" in record && typeof record["subagent_type"] === "string"
  );
}

/**
 * Detect components from real-time captures.
 *
 * Uses PreToolUse hook captures for 100% confidence detection.
 * This is the PRIMARY detection method.
 *
 * Only considers captures where the tool executed successfully.
 * Captures with `success === false` (from PostToolUseFailure hooks)
 * are skipped to avoid false positives.
 *
 * @param captures - Tool captures from execution
 * @returns Array of programmatic detections
 *
 * @example
 * ```typescript
 * const detections = detectFromCaptures(executionResult.detected_tools);
 * // [{ component_type: 'skill', component_name: 'commit', confidence: 100, ... }]
 * ```
 */
export function detectFromCaptures(
  captures: ToolCapture[],
): ProgrammaticDetection[] {
  const detections: ProgrammaticDetection[] = [];

  for (const capture of captures) {
    // Skip captures where tool execution explicitly failed
    // success === undefined means no PostToolUse/PostToolUseFailure was received yet (legacy behavior)
    // success === true means tool executed successfully
    // success === false means tool failed
    if (capture.success === false) {
      continue;
    }

    // Build evidence string with success status
    // At this point, capture.success is either true or undefined (false was filtered above)
    const successInfo =
      capture.success === true ? " (verified successful)" : "";

    if (capture.name === "Skill" && isSkillInput(capture.input)) {
      detections.push({
        component_type: "skill",
        component_name: capture.input.skill,
        confidence: 100,
        tool_name: capture.name,
        evidence: `Skill tool invoked: ${capture.input.skill}${successInfo}`,
        timestamp: capture.timestamp,
      });
    } else if (capture.name === "Task" && isTaskInput(capture.input)) {
      detections.push({
        component_type: "agent",
        component_name: capture.input.subagent_type,
        confidence: 100,
        tool_name: capture.name,
        evidence: `Task tool invoked: ${capture.input.subagent_type}${successInfo}`,
        timestamp: capture.timestamp,
      });
    } else if (capture.name === "SlashCommand" && isSkillInput(capture.input)) {
      // SlashCommand uses same input structure as Skill
      detections.push({
        component_type: "command",
        component_name: capture.input.skill,
        confidence: 100,
        tool_name: capture.name,
        evidence: `SlashCommand invoked: ${capture.input.skill}${successInfo}`,
        timestamp: capture.timestamp,
      });
    } else if (isMcpTool(capture.name)) {
      // MCP tool invocation (mcp__<server>__<tool> pattern)
      const parsed = parseMcpToolName(capture.name);
      if (parsed) {
        detections.push({
          component_type: "mcp_server",
          component_name: parsed.serverName,
          confidence: 100,
          tool_name: capture.name,
          evidence: `MCP tool invoked: ${capture.name} (server: ${parsed.serverName}, tool: ${parsed.toolName})${successInfo}`,
          timestamp: capture.timestamp,
        });
      }
    }
  }

  return detections;
}

/**
 * Detect components from transcript tool calls.
 *
 * Fallback method when captures are unavailable.
 * Parses assistant message tool_calls from transcript events.
 *
 * @param transcript - Execution transcript
 * @returns Array of programmatic detections
 */
export function detectFromTranscript(
  transcript: Transcript,
): ProgrammaticDetection[] {
  const detections: ProgrammaticDetection[] = [];

  for (const event of transcript.events) {
    // Only assistant events have tool_calls
    if (event.type !== "assistant") {
      continue;
    }

    const toolCalls = event.edit.message.tool_calls ?? [];

    for (const tc of toolCalls) {
      if (tc.name === "Skill" && isSkillInput(tc.input)) {
        detections.push({
          component_type: "skill",
          component_name: tc.input.skill,
          confidence: 100,
          tool_name: tc.name,
          evidence: `Skill tool invoked: ${tc.input.skill}`,
          timestamp: 0, // Timestamp unavailable in transcript
        });
      } else if (tc.name === "Task" && isTaskInput(tc.input)) {
        detections.push({
          component_type: "agent",
          component_name: tc.input.subagent_type,
          confidence: 100,
          tool_name: tc.name,
          evidence: `Task tool invoked: ${tc.input.subagent_type}`,
          timestamp: 0,
        });
      } else if (tc.name === "SlashCommand" && isSkillInput(tc.input)) {
        detections.push({
          component_type: "command",
          component_name: tc.input.skill,
          confidence: 100,
          tool_name: tc.name,
          evidence: `SlashCommand invoked: ${tc.input.skill}`,
          timestamp: 0,
        });
      } else if (isMcpTool(tc.name)) {
        // MCP tool invocation from transcript
        const parsed = parseMcpToolName(tc.name);
        if (parsed) {
          detections.push({
            component_type: "mcp_server",
            component_name: parsed.serverName,
            confidence: 100,
            tool_name: tc.name,
            evidence: `MCP tool invoked: ${tc.name} (server: ${parsed.serverName}, tool: ${parsed.toolName})`,
            timestamp: 0,
          });
        }
      }
    }
  }

  return detections;
}

/**
 * Detect direct command invocation from user message.
 *
 * Commands invoked with explicit `/command` syntax in user messages
 * may not appear as SlashCommand tool calls. This catches those cases.
 *
 * @param transcript - Execution transcript
 * @param _scenario - Test scenario (used for validation)
 * @returns Detection if command syntax found, null otherwise
 *
 * @example
 * ```typescript
 * // User message: "/plugin-dev:create-plugin"
 * const detection = detectDirectCommandInvocation(transcript, scenario);
 * // { component_type: 'command', component_name: 'create-plugin', ... }
 * ```
 */
export function detectDirectCommandInvocation(
  transcript: Transcript,
  _scenario: TestScenario,
): ProgrammaticDetection | null {
  // Find the first user message in the transcript
  const firstUserEvent = transcript.events.find((e) => e.type === "user");

  if (firstUserEvent?.type !== "user") {
    return null;
  }

  const content = firstUserEvent.edit.message.content;

  // Check if message starts with /command syntax
  if (!content.startsWith("/")) {
    return null;
  }

  // Match patterns like:
  // - /command
  // - /plugin:command
  // - /plugin:namespace/command
  // - /plugin:namespace:command
  const commandMatch = /^\/([a-z0-9-]+:)?([a-z0-9-/:]+)/i.exec(content);

  if (!commandMatch) {
    return null;
  }

  const commandName = commandMatch[2];

  // Handle namespace/command format - extract just the command part
  const normalizedName = commandName?.includes("/")
    ? (commandName.split("/").pop() ?? commandName)
    : commandName;

  const commandPrefix = content.split(" ")[0] ?? content;

  return {
    component_type: "command",
    component_name: normalizedName ?? "",
    confidence: 100,
    tool_name: "DirectInvocation",
    evidence: `Direct command invocation in user message: ${commandPrefix}`,
    timestamp: 0,
  };
}

/**
 * Correlate captures with transcript tool results as fallback.
 *
 * For captures where PostToolUse/PostToolUseFailure hooks didn't fire
 * (success === undefined), attempt to determine success from transcript
 * tool_result events. Updates captures in place.
 *
 * @param captures - Tool captures to correlate (mutated in place)
 * @param transcript - Execution transcript with tool results
 */
export function correlateWithTranscript(
  captures: ToolCapture[],
  transcript: Transcript,
): void {
  // Build a map of tool_use_id to tool_result for quick lookup
  const toolResultMap = new Map<
    string,
    { result: unknown; isError: boolean }
  >();

  for (const event of transcript.events) {
    if (event.type === "tool_result") {
      // TypeScript narrows to ToolResultEvent which includes is_error
      toolResultMap.set(event.tool_use_id, {
        result: event.result,
        isError: event.is_error === true,
      });
    }
  }

  // Correlate captures with transcript results
  for (const capture of captures) {
    // Only process captures without success status (no PostToolUse fired)
    if (capture.success !== undefined || !capture.toolUseId) {
      continue;
    }

    const toolResult = toolResultMap.get(capture.toolUseId);
    if (toolResult) {
      capture.result = toolResult.result;
      // If transcript has is_error field, use it; otherwise assume success
      capture.success = !toolResult.isError;
    }
  }
}

/**
 * Detect all components using all detection methods.
 *
 * Combines real-time captures, direct command detection, and transcript
 * parsing with priority order for comprehensive detection.
 *
 * For captures without success status from PostToolUse hooks, falls back
 * to transcript correlation to determine tool success.
 *
 * Priority order:
 * 1. Real-time captures from PreToolUse hooks with success status (highest confidence)
 * 2. Direct command invocation in user message
 * 3. Tool calls parsed from transcript (fallback)
 *
 * @param captures - Tool captures from execution
 * @param transcript - Execution transcript
 * @param scenario - Test scenario
 * @returns Array of all detected components
 *
 * @example
 * ```typescript
 * const detections = detectAllComponents(
 *   executionResult.detected_tools,
 *   executionResult.transcript,
 *   testScenario
 * );
 * ```
 */
export function detectAllComponents(
  captures: ToolCapture[],
  transcript: Transcript,
  scenario: TestScenario,
): ProgrammaticDetection[] {
  const detections: ProgrammaticDetection[] = [];

  // 1. Primary: Real-time captures (if available)
  if (captures.length > 0) {
    // Correlate with transcript for captures missing PostToolUse status
    correlateWithTranscript(captures, transcript);
    detections.push(...detectFromCaptures(captures));
  }

  // 2. Direct command detection (for /command syntax)
  if (scenario.component_type === "command") {
    const directDetection = detectDirectCommandInvocation(transcript, scenario);
    if (directDetection) {
      // Only add if not already detected via captures
      const alreadyDetected = detections.some(
        (d) =>
          d.component_type === "command" &&
          d.component_name === directDetection.component_name,
      );
      if (!alreadyDetected) {
        detections.push(directDetection);
      }
    }
  }

  // 3. Fallback: Parse transcript for tool calls
  if (detections.length === 0) {
    detections.push(...detectFromTranscript(transcript));
  }

  return detections;
}

/**
 * Check if expected component was triggered.
 *
 * @param detections - All detected components
 * @param expectedComponent - Expected component name
 * @param expectedType - Expected component type
 * @returns True if expected component was detected
 */
export function wasExpectedComponentTriggered(
  detections: ProgrammaticDetection[],
  expectedComponent: string,
  expectedType: ComponentType,
): boolean {
  return detections.some(
    (d) =>
      d.component_name === expectedComponent &&
      d.component_type === expectedType,
  );
}

/**
 * Get unique components from detections.
 *
 * @param detections - All detections (may contain duplicates)
 * @returns Unique detections by component name and type
 */
export function getUniqueDetections(
  detections: ProgrammaticDetection[],
): ProgrammaticDetection[] {
  const seen = new Set<string>();
  return detections.filter((d) => {
    const key = `${d.component_type}:${d.component_name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Detect hooks from hook response captures.
 *
 * Hook responses are captured via SDKHookResponseMessage during execution.
 * This provides 100% confidence detection for hook activation.
 *
 * @param hookResponses - Hook response captures from execution
 * @returns Array of programmatic detections for hooks
 *
 * @example
 * ```typescript
 * const detections = detectFromHookResponses(executionResult.hook_responses);
 * // [{ component_type: 'hook', component_name: 'PreToolUse:Write', ... }]
 * ```
 */
export function detectFromHookResponses(
  hookResponses: HookResponseCapture[],
): ProgrammaticDetection[] {
  const detections: ProgrammaticDetection[] = [];

  for (const response of hookResponses) {
    // Create unique component name from event type and hook name
    const componentName = response.hookName || `${response.hookEvent}:unknown`;

    detections.push({
      component_type: "hook",
      component_name: componentName,
      confidence: 100,
      tool_name: response.hookEvent,
      evidence: `Hook response: ${response.hookEvent} hook "${response.hookName}" fired${
        response.exitCode !== undefined
          ? ` (exit code: ${String(response.exitCode)})`
          : ""
      }`,
      timestamp: response.timestamp,
    });
  }

  return detections;
}

/**
 * Detect agents from SubagentStart/SubagentStop hook captures.
 *
 * This provides 100% confidence agent detection directly from SDK hooks,
 * as an alternative to parsing Task tool inputs.
 *
 * @param subagentCaptures - Subagent lifecycle captures from SDK hooks
 * @returns Array of programmatic detections for agents
 *
 * @example
 * ```typescript
 * const detections = detectFromSubagentCaptures(executionResult.subagent_captures);
 * // Returns detections with component_type: "agent", component_name: "Explore"
 * ```
 */
export function detectFromSubagentCaptures(
  subagentCaptures: SubagentCapture[],
): ProgrammaticDetection[] {
  const detections: ProgrammaticDetection[] = [];

  for (const capture of subagentCaptures) {
    // Build evidence string with lifecycle info
    const lifecycleInfo =
      capture.stopTimestamp !== undefined
        ? ` (completed in ${String(capture.stopTimestamp - capture.startTimestamp)}ms)`
        : " (started)";

    detections.push({
      component_type: "agent",
      component_name: capture.agentType,
      confidence: 100,
      tool_name: "SubagentStart",
      evidence: `Subagent hook fired: ${capture.agentType} (id: ${capture.agentId})${lifecycleInfo}`,
      timestamp: capture.startTimestamp,
    });
  }

  return detections;
}

/**
 * Check if expected hook was triggered.
 *
 * @param hookResponses - Hook response captures from execution
 * @param expectedHookName - Expected hook component name (e.g., "PreToolUse::Write|Edit")
 * @param expectedEventType - Optional expected event type
 * @returns True if expected hook was detected
 *
 * @example
 * ```typescript
 * const triggered = wasExpectedHookTriggered(
 *   executionResult.hook_responses,
 *   "PreToolUse::Write|Edit",
 *   "PreToolUse"
 * );
 * ```
 */
export function wasExpectedHookTriggered(
  hookResponses: HookResponseCapture[],
  expectedHookName: string,
  expectedEventType?: string,
): boolean {
  if (hookResponses.length === 0) {
    return false;
  }

  return hookResponses.some((response) => {
    // Match by event type if provided
    if (expectedEventType && response.hookEvent !== expectedEventType) {
      return false;
    }

    // Match by hook name
    // The expected name format is "EventType::Matcher" (e.g., "PreToolUse::Write|Edit")
    if (expectedHookName.includes("::")) {
      const [eventType, matcher] = expectedHookName.split("::");
      if (eventType && response.hookEvent !== eventType) {
        return false;
      }
      // Check if response hook name contains the matcher pattern
      if (matcher && !response.hookName.includes(matcher)) {
        return false;
      }
      return true;
    }

    // Direct name match
    return response.hookName === expectedHookName;
  });
}

/**
 * Check if expected MCP server was used.
 *
 * @param detections - Programmatic detections
 * @param expectedServerName - Expected MCP server name
 * @returns True if expected MCP server's tools were invoked
 *
 * @example
 * ```typescript
 * const used = wasExpectedMcpServerUsed(detections, "github");
 * ```
 */
export function wasExpectedMcpServerUsed(
  detections: ProgrammaticDetection[],
  expectedServerName: string,
): boolean {
  return detections.some(
    (d) =>
      d.component_type === "mcp_server" &&
      d.component_name === expectedServerName,
  );
}

/**
 * Detect all components including hooks and MCP servers.
 *
 * Extended version of detectAllComponents that also handles hook and MCP detection.
 *
 * @param captures - Tool captures from execution
 * @param transcript - Execution transcript
 * @param scenario - Test scenario
 * @param hookResponses - Optional hook response captures
 * @param subagentCaptures - Optional subagent lifecycle captures
 * @returns Array of all detected components including hooks, agents, and MCP servers
 */
export function detectAllComponentsWithHooks(
  captures: ToolCapture[],
  transcript: Transcript,
  scenario: TestScenario,
  hookResponses?: HookResponseCapture[],
  subagentCaptures?: SubagentCapture[],
): ProgrammaticDetection[] {
  // Get standard component detections (now includes MCP servers)
  const detections = detectAllComponents(captures, transcript, scenario);

  // Add agent detections from SubagentStart/SubagentStop hooks (100% confidence)
  // This takes priority over Task tool parsing for agent scenarios
  if (
    scenario.component_type === "agent" &&
    subagentCaptures &&
    subagentCaptures.length > 0
  ) {
    const subagentDetections = detectFromSubagentCaptures(subagentCaptures);

    // Filter to avoid duplicate agent detections from Task tool captures
    // SubagentStart hooks provide the same info with explicit lifecycle tracking
    const existingAgentNames = new Set(
      detections
        .filter((d) => d.component_type === "agent")
        .map((d) => d.component_name),
    );

    const newSubagentDetections = subagentDetections.filter(
      (d) => !existingAgentNames.has(d.component_name),
    );

    // Prepend subagent detections to give them priority in unique detection filtering
    detections.unshift(...newSubagentDetections);
  }

  // Add hook detections if this is a hook scenario and we have responses
  if (scenario.component_type === "hook" && hookResponses) {
    const hookDetections = detectFromHookResponses(hookResponses);

    // Filter to matching hooks based on scenario
    const relevantHookDetections = hookDetections.filter((d) => {
      // Match by component reference (e.g., "PreToolUse::Write|Edit")
      const expectedRef = scenario.component_ref;
      if (!expectedRef) {
        return true;
      }

      // Parse expected reference
      if (expectedRef.includes("::")) {
        const [eventType] = expectedRef.split("::");
        return d.tool_name === eventType;
      }

      return true;
    });

    detections.push(...relevantHookDetections);
  }

  return getUniqueDetections(detections);
}
