/**
 * Tests for session batching utilities.
 */

import { describe, expect, it, vi } from "vitest";

import {
  executeBatch,
  groupScenariosByComponent,
  resolveSessionStrategy,
} from "../../../../src/stages/3-execution/session-batching.js";

import {
  createMockExecutionConfig,
  createMockQueryFn,
} from "../../../mocks/sdk-mock.js";

import type {
  ExecutionConfig,
  TestScenario,
} from "../../../../src/types/index.js";

describe("session-batching", () => {
  describe("resolveSessionStrategy", () => {
    const createConfig = (
      overrides: Partial<ExecutionConfig> = {},
    ): ExecutionConfig => ({
      model: "claude-sonnet-4-20250514",
      max_turns: 5,
      timeout_ms: 60000,
      max_budget_usd: 10.0,
      session_isolation: true,
      permission_bypass: true,
      num_reps: 1,
      additional_plugins: [],
      ...overrides,
    });

    it("returns session_strategy when explicitly set to batched", () => {
      const config = createConfig({ session_strategy: "batched_by_component" });
      expect(resolveSessionStrategy(config)).toBe("batched_by_component");
    });

    it("returns isolated when session_strategy is set to isolated", () => {
      const config = createConfig({
        session_isolation: false, // Would map to batched, but explicit strategy takes precedence
        session_strategy: "isolated",
      });
      expect(resolveSessionStrategy(config)).toBe("isolated");
    });

    it("falls back to session_isolation: true -> isolated", () => {
      const config = createConfig({ session_isolation: true });
      expect(resolveSessionStrategy(config)).toBe("isolated");
    });

    it("falls back to session_isolation: false -> batched_by_component", () => {
      const config = createConfig({ session_isolation: false });
      expect(resolveSessionStrategy(config)).toBe("batched_by_component");
    });
  });

  describe("groupScenariosByComponent", () => {
    const createScenario = (
      id: string,
      componentRef: string,
    ): TestScenario => ({
      id,
      scenario_type: "direct",
      component_type: "skill",
      component_ref: componentRef,
      user_prompt: `Test prompt for ${id}`,
      expected_trigger: true,
      expected_component: componentRef,
    });

    it("groups scenarios by component_ref", () => {
      const scenarios: TestScenario[] = [
        createScenario("skill-1-a", "skill:my-skill"),
        createScenario("skill-1-b", "skill:my-skill"),
        createScenario("skill-2-a", "skill:other-skill"),
        createScenario("agent-1-a", "agent:my-agent"),
      ];

      const groups = groupScenariosByComponent(scenarios);

      expect(groups.size).toBe(3);
      expect(groups.get("skill:my-skill::")?.length).toBe(2);
      expect(groups.get("skill:other-skill::")?.length).toBe(1);
      expect(groups.get("agent:my-agent::")?.length).toBe(1);
    });

    it("includes plugin hash in group key", () => {
      const scenarios: TestScenario[] = [
        createScenario("skill-1-a", "skill:my-skill"),
        createScenario("skill-1-b", "skill:my-skill"),
      ];

      const groupsNoPlugins = groupScenariosByComponent(scenarios, []);
      const groupsWithPlugins = groupScenariosByComponent(scenarios, [
        "./plugin-a",
        "./plugin-b",
      ]);

      // Different keys due to plugin hash
      expect(groupsNoPlugins.get("skill:my-skill::")).toBeDefined();
      expect(
        groupsWithPlugins.get("skill:my-skill::./plugin-a|./plugin-b"),
      ).toBeDefined();
    });

    it("sorts plugin paths for consistent hashing", () => {
      const scenarios: TestScenario[] = [
        createScenario("skill-1-a", "skill:my-skill"),
      ];

      const groupsAB = groupScenariosByComponent(scenarios, [
        "./plugin-a",
        "./plugin-b",
      ]);
      const groupsBA = groupScenariosByComponent(scenarios, [
        "./plugin-b",
        "./plugin-a",
      ]);

      // Same key regardless of order
      const keyAB = Array.from(groupsAB.keys())[0];
      const keyBA = Array.from(groupsBA.keys())[0];
      expect(keyAB).toBe(keyBA);
    });

    it("returns empty map for empty scenarios", () => {
      const groups = groupScenariosByComponent([]);
      expect(groups.size).toBe(0);
    });

    it("groups single scenario correctly", () => {
      const scenarios: TestScenario[] = [
        createScenario("only-one", "skill:only-skill"),
      ];

      const groups = groupScenariosByComponent(scenarios);

      expect(groups.size).toBe(1);
      expect(groups.get("skill:only-skill::")).toEqual(scenarios);
    });
  });

  describe("executeBatch with file checkpointing", () => {
    const createBatchScenario = (
      id: string,
      componentRef: string,
    ): TestScenario => ({
      id,
      scenario_type: "direct",
      component_type: "skill",
      component_ref: componentRef,
      user_prompt: `Test prompt for ${id}`,
      expected_trigger: true,
      expected_component: componentRef,
    });

    it("executes batch with checkpointing enabled and calls rewindFiles", async () => {
      const rewindFilesMock = vi.fn().mockResolvedValue(undefined);
      const scenarios = [
        createBatchScenario("scenario-1", "skill:test"),
        createBatchScenario("scenario-2", "skill:test"),
      ];

      const mockQuery = createMockQueryFn({
        triggeredTools: [{ name: "Skill", input: { skill: "test" } }],
        userMessageId: "user-msg-123",
      });

      // Wrap the mock to track rewindFiles calls
      const wrappedQueryFn = (input: unknown) => {
        const queryObj = mockQuery(input as Parameters<typeof mockQuery>[0]);
        return {
          ...queryObj,
          rewindFiles: rewindFilesMock,
        };
      };

      const results = await executeBatch({
        scenarios,
        pluginPath: "/path/to/plugin",
        pluginName: "test-plugin",
        config: createMockExecutionConfig(),
        useCheckpointing: true,
        queryFn: wrappedQueryFn,
      });

      expect(results).toHaveLength(2);
      // rewindFiles should be called after each scenario except the last
      // Actually, it should be called after EVERY scenario to prevent cross-contamination
      expect(rewindFilesMock).toHaveBeenCalledTimes(2);
    });

    it("handles rewindFiles errors gracefully in batch mode", async () => {
      const rewindFilesMock = vi
        .fn()
        .mockRejectedValue(new Error("Rewind failed"));
      const scenarios = [
        createBatchScenario("scenario-1", "skill:test"),
        createBatchScenario("scenario-2", "skill:test"),
      ];

      const mockQuery = createMockQueryFn({
        triggeredTools: [],
        userMessageId: "user-msg-456",
      });

      const wrappedQueryFn = (input: unknown) => {
        const queryObj = mockQuery(input as Parameters<typeof mockQuery>[0]);
        return {
          ...queryObj,
          rewindFiles: rewindFilesMock,
        };
      };

      // Should not throw, just log warning
      const results = await executeBatch({
        scenarios,
        pluginPath: "/path/to/plugin",
        pluginName: "test-plugin",
        config: createMockExecutionConfig(),
        useCheckpointing: true,
        queryFn: wrappedQueryFn,
      });

      expect(results).toHaveLength(2);
      // Scenarios should complete despite rewind failure
      expect(results[0]?.errors).toHaveLength(0);
      expect(results[1]?.errors).toHaveLength(0);
    });

    it("skips rewindFiles when checkpointing is disabled", async () => {
      const rewindFilesMock = vi.fn().mockResolvedValue(undefined);
      const scenarios = [createBatchScenario("scenario-1", "skill:test")];

      const mockQuery = createMockQueryFn({
        triggeredTools: [],
        userMessageId: "user-msg-789",
      });

      const wrappedQueryFn = (input: unknown) => {
        const queryObj = mockQuery(input as Parameters<typeof mockQuery>[0]);
        return {
          ...queryObj,
          rewindFiles: rewindFilesMock,
        };
      };

      await executeBatch({
        scenarios,
        pluginPath: "/path/to/plugin",
        pluginName: "test-plugin",
        config: createMockExecutionConfig(),
        useCheckpointing: false,
        queryFn: wrappedQueryFn,
      });

      // rewindFiles should NOT be called when checkpointing is disabled
      expect(rewindFilesMock).not.toHaveBeenCalled();
    });

    it("enables file checkpointing in query options when useCheckpointing is true", async () => {
      const capturedOptions: unknown[] = [];
      const scenarios = [createBatchScenario("scenario-1", "skill:test")];

      const mockQuery = createMockQueryFn({
        triggeredTools: [],
        userMessageId: "user-msg-test",
      });

      const wrappedQueryFn = (input: unknown) => {
        capturedOptions.push(input);
        return mockQuery(input as Parameters<typeof mockQuery>[0]);
      };

      await executeBatch({
        scenarios,
        pluginPath: "/path/to/plugin",
        pluginName: "test-plugin",
        config: createMockExecutionConfig(),
        useCheckpointing: true,
        queryFn: wrappedQueryFn,
      });

      // Verify enableFileCheckpointing was set in query options
      const queryInput = capturedOptions[0] as {
        options?: { enableFileCheckpointing?: boolean };
      };
      expect(queryInput.options?.enableFileCheckpointing).toBe(true);
    });

    it("handles missing rewindFiles method gracefully", async () => {
      const scenarios = [createBatchScenario("scenario-1", "skill:test")];

      const mockQuery = createMockQueryFn({
        triggeredTools: [],
        userMessageId: "user-msg-no-rewind",
      });

      // Create a query function that returns an object WITHOUT rewindFiles
      const wrappedQueryFn = (input: unknown) => {
        const queryObj = mockQuery(input as Parameters<typeof mockQuery>[0]);
        // Remove rewindFiles to simulate SDK not supporting it
        const { rewindFiles: _removed, ...queryObjWithoutRewind } = queryObj;
        return queryObjWithoutRewind;
      };

      // Should complete without throwing
      const results = await executeBatch({
        scenarios,
        pluginPath: "/path/to/plugin",
        pluginName: "test-plugin",
        config: createMockExecutionConfig(),
        useCheckpointing: true,
        queryFn: wrappedQueryFn,
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.errors).toHaveLength(0);
    });

    it("captures only the first user message ID for checkpointing", async () => {
      const capturedMessageIds: string[] = [];
      const scenarios = [createBatchScenario("scenario-1", "skill:test")];

      // Create a mock that emits multiple user messages
      const mockQuery = createMockQueryFn({
        triggeredTools: [],
        userMessageId: "first-user-msg",
      });

      const rewindFilesMock = vi.fn().mockImplementation((msgId: string) => {
        capturedMessageIds.push(msgId);
        return Promise.resolve();
      });

      const wrappedQueryFn = (input: unknown) => {
        const queryObj = mockQuery(input as Parameters<typeof mockQuery>[0]);
        return {
          ...queryObj,
          rewindFiles: rewindFilesMock,
        };
      };

      await executeBatch({
        scenarios,
        pluginPath: "/path/to/plugin",
        pluginName: "test-plugin",
        config: createMockExecutionConfig(),
        useCheckpointing: true,
        queryFn: wrappedQueryFn,
      });

      // Should have captured the first user message ID
      expect(rewindFilesMock).toHaveBeenCalledTimes(1);
      expect(capturedMessageIds[0]).toBe("first-user-msg");
    });
  });
});
