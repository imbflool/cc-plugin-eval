/**
 * Unit tests for hooks-factory.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCaptureHooksConfig,
  createBatchStatelessHooks,
  createScenarioStatefulHooks,
  assembleHooksConfig,
} from "../../../../src/stages/3-execution/hooks-factory.js";
import type {
  ToolCapture,
  SubagentCapture,
} from "../../../../src/types/index.js";
import type {
  OnToolCapture,
  OnSubagentCapture,
} from "../../../../src/stages/3-execution/tool-capture-hooks.js";

describe("hooks-factory", () => {
  describe("createCaptureHooksConfig", () => {
    let captureMap: Map<string, ToolCapture>;
    let subagentCaptureMap: Map<string, SubagentCapture>;
    let capturedTools: ToolCapture[];
    let capturedSubagents: SubagentCapture[];
    let onToolCapture: OnToolCapture;
    let onSubagentCapture: OnSubagentCapture;

    beforeEach(() => {
      captureMap = new Map();
      subagentCaptureMap = new Map();
      capturedTools = [];
      capturedSubagents = [];
      onToolCapture = (capture: ToolCapture) => capturedTools.push(capture);
      onSubagentCapture = (capture: SubagentCapture) =>
        capturedSubagents.push(capture);
    });

    it("returns SDK-compatible hooks configuration with PascalCase keys", () => {
      const hooksConfig = createCaptureHooksConfig({
        captureMap,
        onToolCapture,
        subagentCaptureMap,
        onSubagentCapture,
      });

      // Verify PascalCase keys (SDK format)
      expect(hooksConfig).toHaveProperty("PreToolUse");
      expect(hooksConfig).toHaveProperty("PostToolUse");
      expect(hooksConfig).toHaveProperty("PostToolUseFailure");
      expect(hooksConfig).toHaveProperty("SubagentStart");
      expect(hooksConfig).toHaveProperty("SubagentStop");
    });

    it("creates hook arrays with matcher and hooks properties", () => {
      const hooksConfig = createCaptureHooksConfig({
        captureMap,
        onToolCapture,
        subagentCaptureMap,
        onSubagentCapture,
      });

      // Each hook type should have an array with one entry
      expect(hooksConfig.PreToolUse).toHaveLength(1);
      expect(hooksConfig.PostToolUse).toHaveLength(1);
      expect(hooksConfig.PostToolUseFailure).toHaveLength(1);
      expect(hooksConfig.SubagentStart).toHaveLength(1);
      expect(hooksConfig.SubagentStop).toHaveLength(1);

      // Each entry should have matcher ".*" to capture all tools
      expect(hooksConfig.PreToolUse[0]).toHaveProperty("matcher", ".*");
      expect(hooksConfig.PostToolUse[0]).toHaveProperty("matcher", ".*");
      expect(hooksConfig.PostToolUseFailure[0]).toHaveProperty("matcher", ".*");
      expect(hooksConfig.SubagentStart[0]).toHaveProperty("matcher", ".*");
      expect(hooksConfig.SubagentStop[0]).toHaveProperty("matcher", ".*");
    });

    it("creates hooks arrays with hook callbacks", () => {
      const hooksConfig = createCaptureHooksConfig({
        captureMap,
        onToolCapture,
        subagentCaptureMap,
        onSubagentCapture,
      });

      // Each entry should have a hooks array with at least one callback
      expect(hooksConfig.PreToolUse[0].hooks).toHaveLength(1);
      expect(hooksConfig.PostToolUse[0].hooks).toHaveLength(1);
      expect(hooksConfig.PostToolUseFailure[0].hooks).toHaveLength(1);
      expect(hooksConfig.SubagentStart[0].hooks).toHaveLength(1);
      expect(hooksConfig.SubagentStop[0].hooks).toHaveLength(1);

      // All hook callbacks should be functions
      expect(typeof hooksConfig.PreToolUse[0].hooks[0]).toBe("function");
      expect(typeof hooksConfig.PostToolUse[0].hooks[0]).toBe("function");
      expect(typeof hooksConfig.PostToolUseFailure[0].hooks[0]).toBe(
        "function",
      );
      expect(typeof hooksConfig.SubagentStart[0].hooks[0]).toBe("function");
      expect(typeof hooksConfig.SubagentStop[0].hooks[0]).toBe("function");
    });

    it("PreToolUse hook captures tool invocation and calls onToolCapture", async () => {
      const hooksConfig = createCaptureHooksConfig({
        captureMap,
        onToolCapture,
        subagentCaptureMap,
        onSubagentCapture,
      });

      const preToolUseHook = hooksConfig.PreToolUse[0].hooks[0];
      // Cast to unknown to bypass strict type checking for test input
      const input = {
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
      } as unknown;
      const toolUseId = "test-tool-use-id";

      await preToolUseHook(input, toolUseId, undefined);

      // Should have called onToolCapture with capture data
      expect(capturedTools).toHaveLength(1);
      const capture = capturedTools[0];
      expect(capture.name).toBe("Read");
      expect(capture.input).toEqual({ file_path: "/test.ts" });
      expect(capture.toolUseId).toBe(toolUseId);
      expect(typeof capture.timestamp).toBe("number");

      // Should have stored in captureMap for correlation
      expect(captureMap.has(toolUseId)).toBe(true);
    });

    it("PostToolUse hook updates capture with success status", async () => {
      const hooksConfig = createCaptureHooksConfig({
        captureMap,
        onToolCapture,
        subagentCaptureMap,
        onSubagentCapture,
      });

      const preToolUseHook = hooksConfig.PreToolUse[0].hooks[0];
      const postToolUseHook = hooksConfig.PostToolUse[0].hooks[0];
      const toolUseId = "test-tool-use-id";

      // First, trigger PreToolUse to create the capture
      await preToolUseHook(
        { tool_name: "Read", tool_input: {} } as unknown,
        toolUseId,
        undefined,
      );

      // Then trigger PostToolUse
      await postToolUseHook(
        { tool_response: "file contents" } as unknown,
        toolUseId,
        undefined,
      );

      // Capture should be updated with success
      const capture = captureMap.get(toolUseId);
      expect(capture?.success).toBe(true);
      expect(capture?.result).toBe("file contents");
    });

    it("SubagentStart hook captures agent spawn and calls onSubagentCapture", async () => {
      const hooksConfig = createCaptureHooksConfig({
        captureMap,
        onToolCapture,
        subagentCaptureMap,
        onSubagentCapture,
      });

      const subagentStartHook = hooksConfig.SubagentStart[0].hooks[0];
      const input = {
        agent_id: "agent-123",
        agent_type: "Explore",
      } as unknown;

      await subagentStartHook(input, undefined, undefined);

      // Should have called onSubagentCapture
      expect(capturedSubagents).toHaveLength(1);
      const capture = capturedSubagents[0];
      expect(capture.agentId).toBe("agent-123");
      expect(capture.agentType).toBe("Explore");
      expect(typeof capture.startTimestamp).toBe("number");

      // Should have stored in subagentCaptureMap
      expect(subagentCaptureMap.has("agent-123")).toBe(true);
    });
  });

  describe("createBatchStatelessHooks", () => {
    let captureMap: Map<string, ToolCapture>;
    let subagentCaptureMap: Map<string, SubagentCapture>;

    beforeEach(() => {
      captureMap = new Map();
      subagentCaptureMap = new Map();
    });

    it("creates stateless hooks that only depend on capture maps", () => {
      const hooks = createBatchStatelessHooks({
        captureMap,
        subagentCaptureMap,
      });

      expect(typeof hooks.postToolUseHook).toBe("function");
      expect(typeof hooks.postToolUseFailureHook).toBe("function");
      expect(typeof hooks.subagentStopHook).toBe("function");
    });

    it("postToolUseHook updates captures in shared map", async () => {
      const hooks = createBatchStatelessHooks({
        captureMap,
        subagentCaptureMap,
      });

      // Simulate a PreToolUse by adding to the map directly
      const toolUseId = "tool-123";
      const capture: ToolCapture = {
        name: "Read",
        input: { file_path: "/test.ts" },
        toolUseId,
        timestamp: Date.now(),
      };
      captureMap.set(toolUseId, capture);

      // Call PostToolUse hook
      await hooks.postToolUseHook(
        { tool_response: "file contents" } as unknown,
        toolUseId,
        undefined,
      );

      // Verify capture was updated
      expect(captureMap.get(toolUseId)?.success).toBe(true);
      expect(captureMap.get(toolUseId)?.result).toBe("file contents");
    });

    it("subagentStopHook updates captures in shared map", async () => {
      const hooks = createBatchStatelessHooks({
        captureMap,
        subagentCaptureMap,
      });

      // Simulate SubagentStart by adding to the map directly
      const agentId = "agent-456";
      const subagentCapture: SubagentCapture = {
        agentId,
        agentType: "Explore",
        startTimestamp: Date.now(),
      };
      subagentCaptureMap.set(agentId, subagentCapture);

      // Call SubagentStop hook
      await hooks.subagentStopHook(
        { agent_id: agentId } as unknown,
        undefined,
        undefined,
      );

      // Verify capture was updated with stop timestamp
      expect(subagentCaptureMap.get(agentId)?.stopTimestamp).toBeDefined();
    });

    it("hooks can be reused after clearing maps", async () => {
      const hooks = createBatchStatelessHooks({
        captureMap,
        subagentCaptureMap,
      });

      // First scenario
      const toolUseId1 = "tool-1";
      captureMap.set(toolUseId1, {
        name: "Read",
        input: {},
        toolUseId: toolUseId1,
        timestamp: Date.now(),
      });
      await hooks.postToolUseHook(
        { tool_response: "first" } as unknown,
        toolUseId1,
        undefined,
      );
      expect(captureMap.get(toolUseId1)?.result).toBe("first");

      // Clear maps for next scenario
      captureMap.clear();
      subagentCaptureMap.clear();

      // Second scenario - same hooks work correctly
      const toolUseId2 = "tool-2";
      captureMap.set(toolUseId2, {
        name: "Write",
        input: {},
        toolUseId: toolUseId2,
        timestamp: Date.now(),
      });
      await hooks.postToolUseHook(
        { tool_response: "second" } as unknown,
        toolUseId2,
        undefined,
      );
      expect(captureMap.get(toolUseId2)?.result).toBe("second");

      // First scenario's data is gone (isolation verified)
      expect(captureMap.has(toolUseId1)).toBe(false);
    });
  });

  describe("createScenarioStatefulHooks", () => {
    let captureMap: Map<string, ToolCapture>;
    let subagentCaptureMap: Map<string, SubagentCapture>;

    beforeEach(() => {
      captureMap = new Map();
      subagentCaptureMap = new Map();
    });

    it("creates stateful hooks with closures over callbacks", () => {
      const capturedTools: ToolCapture[] = [];
      const capturedSubagents: SubagentCapture[] = [];

      const hooks = createScenarioStatefulHooks({
        captureMap,
        onToolCapture: (c) => capturedTools.push(c),
        subagentCaptureMap,
        onSubagentCapture: (c) => capturedSubagents.push(c),
      });

      expect(typeof hooks.preToolUseHook).toBe("function");
      expect(typeof hooks.subagentStartHook).toBe("function");
    });

    it("preToolUseHook calls the closure-bound callback", async () => {
      const capturedTools: ToolCapture[] = [];

      const hooks = createScenarioStatefulHooks({
        captureMap,
        onToolCapture: (c) => capturedTools.push(c),
        subagentCaptureMap,
        onSubagentCapture: () => {},
      });

      await hooks.preToolUseHook(
        { tool_name: "Skill", tool_input: { skill: "test" } } as unknown,
        "tool-use-id",
        undefined,
      );

      expect(capturedTools).toHaveLength(1);
      expect(capturedTools[0].name).toBe("Skill");
    });

    it("maintains capture isolation between scenarios with fresh hooks", async () => {
      // Simulate two scenarios with fresh stateful hooks each

      // Scenario 1
      const scenario1Tools: ToolCapture[] = [];
      const hooks1 = createScenarioStatefulHooks({
        captureMap,
        onToolCapture: (c) => scenario1Tools.push(c),
        subagentCaptureMap,
        onSubagentCapture: () => {},
      });

      await hooks1.preToolUseHook(
        { tool_name: "Read", tool_input: {} } as unknown,
        "tool-1",
        undefined,
      );

      // Clear maps between scenarios (as the batch executor would)
      captureMap.clear();
      subagentCaptureMap.clear();

      // Scenario 2 - fresh hooks with new callback target
      const scenario2Tools: ToolCapture[] = [];
      const hooks2 = createScenarioStatefulHooks({
        captureMap,
        onToolCapture: (c) => scenario2Tools.push(c),
        subagentCaptureMap,
        onSubagentCapture: () => {},
      });

      await hooks2.preToolUseHook(
        { tool_name: "Write", tool_input: {} } as unknown,
        "tool-2",
        undefined,
      );

      // Verify isolation: each scenario has only its own tools
      expect(scenario1Tools).toHaveLength(1);
      expect(scenario1Tools[0].name).toBe("Read");
      expect(scenario2Tools).toHaveLength(1);
      expect(scenario2Tools[0].name).toBe("Write");
    });
  });

  describe("assembleHooksConfig", () => {
    let captureMap: Map<string, ToolCapture>;
    let subagentCaptureMap: Map<string, SubagentCapture>;

    beforeEach(() => {
      captureMap = new Map();
      subagentCaptureMap = new Map();
    });

    it("combines stateless and stateful hooks into SDK-compatible config", () => {
      const statelessHooks = createBatchStatelessHooks({
        captureMap,
        subagentCaptureMap,
      });

      const statefulHooks = createScenarioStatefulHooks({
        captureMap,
        onToolCapture: () => {},
        subagentCaptureMap,
        onSubagentCapture: () => {},
      });

      const config = assembleHooksConfig(statelessHooks, statefulHooks);

      // Verify SDK-compatible structure
      expect(config.PreToolUse).toHaveLength(1);
      expect(config.PostToolUse).toHaveLength(1);
      expect(config.PostToolUseFailure).toHaveLength(1);
      expect(config.SubagentStart).toHaveLength(1);
      expect(config.SubagentStop).toHaveLength(1);

      // All have ".*" matcher
      expect(config.PreToolUse[0].matcher).toBe(".*");
      expect(config.PostToolUse[0].matcher).toBe(".*");

      // Hooks are functions
      expect(typeof config.PreToolUse[0].hooks[0]).toBe("function");
      expect(typeof config.PostToolUse[0].hooks[0]).toBe("function");
    });

    it("assembled config produces equivalent behavior to createCaptureHooksConfig", async () => {
      // Create captures arrays for both approaches
      const capturedToolsOld: ToolCapture[] = [];
      const capturedToolsNew: ToolCapture[] = [];

      // Old approach (createCaptureHooksConfig)
      const oldConfig = createCaptureHooksConfig({
        captureMap: new Map(),
        onToolCapture: (c) => capturedToolsOld.push(c),
        subagentCaptureMap: new Map(),
        onSubagentCapture: () => {},
      });

      // New approach (assemble)
      const newCaptureMap = new Map<string, ToolCapture>();
      const newSubagentCaptureMap = new Map<string, SubagentCapture>();
      const statelessHooks = createBatchStatelessHooks({
        captureMap: newCaptureMap,
        subagentCaptureMap: newSubagentCaptureMap,
      });
      const statefulHooks = createScenarioStatefulHooks({
        captureMap: newCaptureMap,
        onToolCapture: (c) => capturedToolsNew.push(c),
        subagentCaptureMap: newSubagentCaptureMap,
        onSubagentCapture: () => {},
      });
      const newConfig = assembleHooksConfig(statelessHooks, statefulHooks);

      // Call PreToolUse on both
      await oldConfig.PreToolUse[0].hooks[0](
        { tool_name: "Skill", tool_input: { skill: "test" } } as unknown,
        "tool-old",
        undefined,
      );
      await newConfig.PreToolUse[0].hooks[0](
        { tool_name: "Skill", tool_input: { skill: "test" } } as unknown,
        "tool-new",
        undefined,
      );

      // Both should have captured the tool
      expect(capturedToolsOld).toHaveLength(1);
      expect(capturedToolsNew).toHaveLength(1);
      expect(capturedToolsOld[0].name).toBe(capturedToolsNew[0].name);
    });
  });
});
