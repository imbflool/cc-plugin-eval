/**
 * End-to-End Pipeline Integration Tests
 *
 * These tests exercise the complete 4-stage pipeline with real Anthropic SDK calls.
 * They are gated behind the RUN_E2E_TESTS environment variable to prevent
 * accidental API costs during regular test runs.
 *
 * Run with: RUN_E2E_TESTS=true npm test
 *
 * @module tests/e2e/pipeline
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runAnalysis } from "../../src/stages/1-analysis/index.js";
import { runGeneration } from "../../src/stages/2-generation/index.js";
import {
  runExecution,
  consoleProgress,
} from "../../src/stages/3-execution/index.js";
import { runEvaluation } from "../../src/stages/4-evaluation/index.js";

import {
  shouldRunE2E,
  validateE2EEnvironment,
  createE2EConfig,
  isWithinE2EBudget,
} from "./helpers.js";

// Skip all tests if E2E is not enabled
const describeE2E = shouldRunE2E() ? describe : describe.skip;

// Track metrics across all tests for performance monitoring
let totalE2ECost = 0;
let e2eStartTime = 0;
let e2eTestCount = 0;

describeE2E("E2E: Full Pipeline Integration", () => {
  beforeAll(() => {
    validateE2EEnvironment();
    e2eStartTime = Date.now();
  });

  afterAll(() => {
    const totalDurationMs = Date.now() - e2eStartTime;
    const totalDurationSec = totalDurationMs / 1000;

    console.log("\n========================================");
    console.log("E2E Performance Metrics");
    console.log("========================================");
    console.log(`Total Cost:       $${totalE2ECost.toFixed(4)}`);
    console.log(`Total Duration:   ${totalDurationSec.toFixed(1)}s`);
    console.log(`Tests Executed:   ${e2eTestCount}`);
    if (totalDurationSec > 0) {
      console.log(
        `Cost Efficiency:  $${((totalE2ECost / totalDurationSec) * 60).toFixed(4)}/min`,
      );
      console.log(
        `Avg Time/Test:    ${(totalDurationSec / Math.max(e2eTestCount, 1)).toFixed(1)}s`,
      );
    }
    console.log("========================================\n");
  });

  describe("Stage 1: Analysis", () => {
    it("analyzes the test plugin and extracts components", async () => {
      const config = createE2EConfig({
        scope: { skills: true, agents: true, commands: true },
      });

      const analysis = await runAnalysis(config);

      // Verify plugin was analyzed
      expect(analysis.plugin_name).toBe("test-plugin");
      expect(analysis.plugin_load_result).toBeDefined();

      // Verify components were extracted
      expect(analysis.components.skills.length).toBeGreaterThan(0);
      expect(analysis.components.agents.length).toBeGreaterThan(0);
      expect(analysis.components.commands.length).toBeGreaterThan(0);

      // Verify trigger understanding was built
      const skillNames = analysis.components.skills.map((s) => s.name);
      for (const name of skillNames) {
        expect(analysis.trigger_understanding.skills[name]).toBeDefined();
      }
    });
  });

  describe("Stage 1-2: Analysis and Generation", () => {
    it("generates scenarios for skill components", async () => {
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
      });

      // Stage 1
      const analysis = await runAnalysis(config);
      expect(analysis.components.skills.length).toBeGreaterThan(0);

      // Stage 2
      const generation = await runGeneration(analysis, config);

      // Verify scenarios were generated
      expect(generation.scenarios.length).toBeGreaterThan(0);

      // Verify scenario structure
      for (const scenario of generation.scenarios) {
        expect(scenario.id).toBeDefined();
        expect(scenario.component_ref).toBeDefined();
        expect(scenario.component_type).toBe("skill");
        expect(scenario.user_prompt).toBeDefined();
        expect(typeof scenario.expected_trigger).toBe("boolean");
      }

      // Verify cost estimate
      expect(generation.cost_estimate).toBeDefined();
    });

    it("generates scenarios for command components", async () => {
      const config = createE2EConfig({
        scope: { commands: true },
        generation: { scenarios_per_component: 1 },
      });

      const analysis = await runAnalysis(config);
      expect(analysis.components.commands.length).toBeGreaterThan(0);

      const generation = await runGeneration(analysis, config);

      // Commands use deterministic generation
      expect(generation.scenarios.length).toBeGreaterThan(0);

      const commandScenarios = generation.scenarios.filter(
        (s) => s.component_type === "command",
      );
      expect(commandScenarios.length).toBeGreaterThan(0);
    });
  });

  describe("Stage 1-3: Analysis, Generation, Execution", () => {
    it("executes skill scenarios with real SDK", async () => {
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1
      const analysis = await runAnalysis(config);

      // Stage 2
      const generation = await runGeneration(analysis, config);
      expect(generation.scenarios.length).toBeGreaterThan(0);

      // Stage 3 - Real SDK execution
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      // Track cost and test count
      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinE2EBudget(totalE2ECost)).toBe(true);

      // Verify execution results
      expect(execution.results.length).toBe(generation.scenarios.length);
      expect(execution.plugin_name).toBe("test-plugin");

      // Verify each result has expected structure
      for (const result of execution.results) {
        expect(result.scenario_id).toBeDefined();
        expect(result.transcript).toBeDefined();
        expect(result.transcript.metadata.version).toBe("v3.0");
        expect(result.detected_tools).toBeDefined();
        expect(typeof result.cost_usd).toBe("number");
        expect(typeof result.num_turns).toBe("number");
      }

      // Log execution stats for visibility
      console.log(
        `\nE2E Skill Execution: ${execution.results.length} scenarios, ` +
          `$${execution.total_cost_usd.toFixed(4)} cost, ` +
          `${execution.total_tools_captured} tools captured`,
      );
    }, 120000); // 2 minute timeout for real API calls

    it("executes command scenarios with real SDK", async () => {
      const config = createE2EConfig({
        scope: { commands: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1
      const analysis = await runAnalysis(config);

      // Stage 2
      const generation = await runGeneration(analysis, config);
      expect(generation.scenarios.length).toBeGreaterThan(0);

      // Stage 3
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinE2EBudget(totalE2ECost)).toBe(true);

      expect(execution.results.length).toBeGreaterThan(0);

      console.log(
        `\nE2E Command Execution: ${execution.results.length} scenarios, ` +
          `$${execution.total_cost_usd.toFixed(4)} cost`,
      );
    }, 120000);
  });

  describe("Stage 1-4: Full Pipeline", () => {
    it("runs complete pipeline for skills", async () => {
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1: Analysis
      const analysis = await runAnalysis(config);
      expect(analysis.components.skills.length).toBeGreaterThan(0);

      // Stage 2: Generation
      const generation = await runGeneration(analysis, config);
      expect(generation.scenarios.length).toBeGreaterThan(0);

      // Stage 3: Execution
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinE2EBudget(totalE2ECost)).toBe(true);

      // Stage 4: Evaluation
      const evaluation = await runEvaluation(
        analysis.plugin_name,
        generation.scenarios,
        execution.results,
        config,
        consoleProgress,
      );

      // Verify evaluation metrics
      expect(evaluation.metrics).toBeDefined();
      expect(typeof evaluation.metrics.accuracy).toBe("number");
      expect(typeof evaluation.metrics.trigger_rate).toBe("number");
      expect(evaluation.metrics.total_scenarios).toBe(
        generation.scenarios.length,
      );

      // Verify evaluation results
      expect(evaluation.results.length).toBe(generation.scenarios.length);
      for (const result of evaluation.results) {
        expect(result.scenario_id).toBeDefined();
        expect(typeof result.triggered).toBe("boolean");
        expect(result.detection_source).toBeDefined();
      }

      // Log final results
      console.log(
        `\nE2E Full Pipeline Complete:` +
          `\n  Accuracy: ${(evaluation.metrics.accuracy * 100).toFixed(1)}%` +
          `\n  Trigger Rate: ${(evaluation.metrics.trigger_rate * 100).toFixed(1)}%` +
          `\n  Total Cost: $${totalE2ECost.toFixed(4)}`,
      );
    }, 180000); // 3 minute timeout for full pipeline

    it("runs complete pipeline for commands", async () => {
      const config = createE2EConfig({
        scope: { commands: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Full pipeline
      const analysis = await runAnalysis(config);
      const generation = await runGeneration(analysis, config);
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinE2EBudget(totalE2ECost)).toBe(true);

      const evaluation = await runEvaluation(
        analysis.plugin_name,
        generation.scenarios,
        execution.results,
        config,
        consoleProgress,
      );

      // Commands should have high programmatic detection rate
      const programmaticResults = evaluation.results.filter(
        (r) => r.detection_source === "programmatic",
      );
      expect(programmaticResults.length).toBeGreaterThan(0);

      console.log(
        `\nE2E Command Pipeline:` +
          `\n  Programmatic detections: ${programmaticResults.length}/${evaluation.results.length}` +
          `\n  Accuracy: ${(evaluation.metrics.accuracy * 100).toFixed(1)}%`,
      );
    }, 180000);
  });

  describe("Cost Tracking Validation", () => {
    it("tracks actual cost against estimates", async () => {
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      const analysis = await runAnalysis(config);
      const generation = await runGeneration(analysis, config);

      // Get cost estimate before execution
      const estimatedCost =
        generation.cost_estimate?.total_estimated_cost_usd ?? 0;

      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;

      // Verify actual cost is within reasonable range of estimate
      // Allow 3x variance since estimates are conservative
      if (estimatedCost > 0) {
        expect(execution.total_cost_usd).toBeLessThan(estimatedCost * 3);
      }

      console.log(
        `\nE2E Cost Tracking:` +
          `\n  Estimated: $${estimatedCost.toFixed(4)}` +
          `\n  Actual: $${execution.total_cost_usd.toFixed(4)}` +
          `\n  Ratio: ${estimatedCost > 0 ? (execution.total_cost_usd / estimatedCost).toFixed(2) : "N/A"}x`,
      );
    }, 120000);
  });

  describe("Error Handling", () => {
    it("handles budget exceeded gracefully", async () => {
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 1,
          max_budget_usd: 0.0001, // Tiny budget to trigger limit
        },
      });

      const analysis = await runAnalysis(config);
      const generation = await runGeneration(analysis, config);

      // Should not throw, but may have limited results
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      // Verify execution completed (may have partial results)
      expect(execution).toBeDefined();
      expect(execution.results).toBeDefined();
    }, 60000);
  });
});

// Additional test suite for isolated stage validation
describeE2E("E2E: Stage Isolation", () => {
  describe("Analysis Validation", () => {
    it("handles all component types", async () => {
      const config = createE2EConfig({
        scope: {
          skills: true,
          agents: true,
          commands: true,
          hooks: true,
          mcp_servers: true,
        },
      });

      const analysis = await runAnalysis(config);

      // All component arrays should exist
      expect(Array.isArray(analysis.components.skills)).toBe(true);
      expect(Array.isArray(analysis.components.agents)).toBe(true);
      expect(Array.isArray(analysis.components.commands)).toBe(true);
      expect(Array.isArray(analysis.components.hooks)).toBe(true);
      expect(Array.isArray(analysis.components.mcp_servers)).toBe(true);

      // Trigger understanding should exist for each type
      expect(analysis.trigger_understanding.skills).toBeDefined();
      expect(analysis.trigger_understanding.agents).toBeDefined();
      expect(analysis.trigger_understanding.commands).toBeDefined();
      expect(analysis.trigger_understanding.hooks).toBeDefined();
      expect(analysis.trigger_understanding.mcp_servers).toBeDefined();
    });
  });

  describe("Generation Validation", () => {
    // NOTE: This test validates that command scenario generation is DETERMINISTIC,
    // unlike skill/agent generation which uses LLM and produces varied outputs.
    // Commands use template-based generation (see command-scenario-generator.ts),
    // so running generation twice with the same input should produce identical
    // scenario structures. This is important because:
    // 1. It ensures command tests are reproducible
    // 2. It validates the deterministic generation path works correctly
    // 3. It distinguishes command generation from LLM-based generation
    it("generates deterministic scenarios for commands", async () => {
      const config = createE2EConfig({
        scope: { commands: true },
        generation: { scenarios_per_component: 1 },
      });

      const analysis = await runAnalysis(config);
      const gen1 = await runGeneration(analysis, config);
      const gen2 = await runGeneration(analysis, config);

      // Command scenarios should be deterministic (same input = same output)
      expect(gen1.scenarios.length).toBe(gen2.scenarios.length);

      // Command scenario types should match
      const types1 = gen1.scenarios.map((s) => s.scenario_type).sort();
      const types2 = gen2.scenarios.map((s) => s.scenario_type).sort();
      expect(types1).toEqual(types2);
    });
  });

  describe("Evaluation Validation", () => {
    it("uses programmatic detection for tool captures", async () => {
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
        execution: { max_turns: 2, max_budget_usd: 0.03 },
        evaluation: { detection_mode: "programmatic_first" },
      });

      const analysis = await runAnalysis(config);
      const generation = await runGeneration(analysis, config);
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;

      const evaluation = await runEvaluation(
        analysis.plugin_name,
        generation.scenarios,
        execution.results,
        config,
        consoleProgress,
      );

      // With detected_tools populated, programmatic detection should work
      const hasToolCaptures = execution.results.some(
        (r) => r.detected_tools.length > 0,
      );

      if (hasToolCaptures) {
        // At least some detections should be programmatic
        const programmaticCount = evaluation.results.filter(
          (r) => r.detection_source === "programmatic",
        ).length;
        expect(programmaticCount).toBeGreaterThan(0);
      }
    }, 180000);
  });

  describe("Session Strategy Validation", () => {
    it("validates isolated session mode still works", async () => {
      // Explicitly test isolated mode to ensure backward compatibility
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          session_isolation: true, // Override to test isolated mode
          max_turns: 2,
          max_budget_usd: 0.02,
        },
      });

      const analysis = await runAnalysis(config);

      // Only proceed if we have skills to test
      if (analysis.components.skills.length === 0) {
        console.log("Skipping isolated mode test: no skills in test plugin");
        return;
      }

      const generation = await runGeneration(analysis, config);
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinE2EBudget(totalE2ECost)).toBe(true);

      // Verify isolated mode execution completed successfully
      expect(execution.results.length).toBe(generation.scenarios.length);
      expect(execution.results.every((r) => r.status === "completed")).toBe(
        true,
      );

      console.log(
        `\nE2E Isolated Mode: ${execution.results.length} scenarios, ` +
          `$${execution.total_cost_usd.toFixed(4)} cost`,
      );
    }, 120000);
  });
});
