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

import type { TestScenario } from "../../src/types/index.js";

import {
  shouldRunE2E,
  shouldRunE2EMcp,
  validateE2EEnvironment,
  createE2EConfig,
  isWithinE2EBudget,
  isWithinPerTestBudget,
} from "./helpers.js";

// Skip all tests if E2E is not enabled
const describeE2E = shouldRunE2E() ? describe : describe.skip;

// Skip MCP tests unless explicitly enabled (slow due to server startup)
const describeMcp = shouldRunE2EMcp() ? describe : describe.skip;

// Track metrics across all tests for performance monitoring and reporting.
// NOTE: These module-level variables are append-only and used for aggregate
// reporting in afterAll. Individual test budget validation uses per-test cost
// assertions (isWithinPerTestBudget) to avoid order-dependent test failures.
let totalE2ECost = 0;
let e2eStartTime = 0;
let e2eTestCount = 0;

// Module-level afterAll ensures total budget validation runs regardless of
// which test suites are executed (e.g., when running tests with --grep filter)
afterAll(() => {
  // Only validate if tests actually ran and incurred costs
  if (e2eTestCount > 0) {
    expect(isWithinE2EBudget(totalE2ECost)).toBe(true);
  }
});

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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

      expect(execution.results.length).toBeGreaterThan(0);

      console.log(
        `\nE2E Command Execution: ${execution.results.length} scenarios, ` +
          `$${execution.total_cost_usd.toFixed(4)} cost`,
      );
    }, 120000);

    it("executes agent scenarios with real SDK", async () => {
      const config = createE2EConfig({
        scope: { agents: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1
      const analysis = await runAnalysis(config);
      expect(analysis.components.agents.length).toBeGreaterThan(0);

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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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
        `\nE2E Agent Execution: ${execution.results.length} scenarios, ` +
          `$${execution.total_cost_usd.toFixed(4)} cost, ` +
          `${execution.total_tools_captured} tools captured`,
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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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

    it("runs complete pipeline for agents", async () => {
      const config = createE2EConfig({
        scope: { agents: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1: Analysis
      const analysis = await runAnalysis(config);
      expect(analysis.components.agents.length).toBeGreaterThan(0);

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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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

      // Agents are detected via Task tool with agent input
      const programmaticResults = evaluation.results.filter(
        (r) => r.detection_source === "programmatic",
      );

      // Log final results
      console.log(
        `\nE2E Agent Pipeline Complete:` +
          `\n  Accuracy: ${(evaluation.metrics.accuracy * 100).toFixed(1)}%` +
          `\n  Trigger Rate: ${(evaluation.metrics.trigger_rate * 100).toFixed(1)}%` +
          `\n  Programmatic detections: ${programmaticResults.length}/${evaluation.results.length}` +
          `\n  Total Cost: $${totalE2ECost.toFixed(4)}`,
      );
    }, 180000);
  });

  // Phase 1: Template-based negative scenarios with manual construction
  // Future phases may include LLM-based negative generation, hook/MCP coverage
  describe("Negative Scenarios", () => {
    it("correctly identifies non-triggering prompts for skills", async () => {
      const config = createE2EConfig({
        scope: { skills: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1: Analysis - need skill component info
      const analysis = await runAnalysis(config);
      expect(analysis.components.skills.length).toBeGreaterThan(0);

      // Get the first skill to create a negative scenario
      const targetSkill = analysis.components.skills[0];

      // Create a negative scenario manually - unrelated prompt
      const negativeScenario: TestScenario = {
        id: `negative-skill-${targetSkill.name}`,
        component_ref: targetSkill.name,
        component_type: "skill",
        user_prompt: "What is the weather like today in Seattle?",
        expected_trigger: false,
        scenario_type: "negative",
        rationale:
          "Weather query is unrelated to any skill triggers and should not activate the skill.",
      };

      // Stage 3: Execute the negative scenario
      const execution = await runExecution(
        analysis,
        [negativeScenario],
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

      // Stage 4: Evaluate
      const evaluation = await runEvaluation(
        analysis.plugin_name,
        [negativeScenario],
        execution.results,
        config,
        consoleProgress,
      );

      // Verify the skill was NOT triggered
      expect(evaluation.results.length).toBe(1);
      const result = evaluation.results[0];

      // A correctly handled negative scenario should have:
      // - triggered: false (skill not invoked)
      // - expected_trigger: false (we expected no trigger)
      // - correct: true (false negative is correct)
      if (result.triggered === false) {
        console.log(
          `\nE2E Negative Skill Test: PASS` +
            `\n  Prompt: "${negativeScenario.user_prompt.slice(0, 50)}..."` +
            `\n  Skill: ${targetSkill.name}` +
            `\n  Triggered: ${result.triggered}` +
            `\n  Expected: ${negativeScenario.expected_trigger}`,
        );
      } else {
        console.log(
          `\nE2E Negative Skill Test: FALSE POSITIVE` +
            `\n  The skill was unexpectedly triggered by an unrelated prompt.` +
            `\n  This may indicate overly broad skill triggers.`,
        );
      }

      // Assert the skill was NOT triggered - this is the core validation.
      // If this fails, it indicates a false positive (overly broad triggers
      // or detection bug). The prompts are deliberately maximally unrelated.
      expect(result.triggered).toBe(false);
    }, 120000);

    it("correctly identifies non-triggering prompts for agents", async () => {
      const config = createE2EConfig({
        scope: { agents: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1: Analysis - need agent component info
      const analysis = await runAnalysis(config);
      expect(analysis.components.agents.length).toBeGreaterThan(0);

      // Get the first agent to create a negative scenario
      const targetAgent = analysis.components.agents[0];

      // Create a negative scenario - unrelated prompt that shouldn't trigger
      // test-agent triggers on "analyze code quality" or "review my code"
      const negativeScenario: TestScenario = {
        id: `negative-agent-${targetAgent.name}`,
        component_ref: targetAgent.name,
        component_type: "agent",
        user_prompt: "Calculate the factorial of 10 for me.",
        expected_trigger: false,
        scenario_type: "negative",
        rationale:
          "Math calculation is unrelated to code quality analysis and should not activate the agent.",
      };

      // Stage 3: Execute
      const execution = await runExecution(
        analysis,
        [negativeScenario],
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

      // Stage 4: Evaluate
      const evaluation = await runEvaluation(
        analysis.plugin_name,
        [negativeScenario],
        execution.results,
        config,
        consoleProgress,
      );

      // Verify results
      expect(evaluation.results.length).toBe(1);
      const result = evaluation.results[0];

      if (result.triggered === false) {
        console.log(
          `\nE2E Negative Agent Test: PASS` +
            `\n  Prompt: "${negativeScenario.user_prompt.slice(0, 50)}..."` +
            `\n  Agent: ${targetAgent.name}` +
            `\n  Triggered: ${result.triggered}` +
            `\n  Expected: ${negativeScenario.expected_trigger}`,
        );
      } else {
        console.log(
          `\nE2E Negative Agent Test: FALSE POSITIVE` +
            `\n  The agent was unexpectedly triggered by an unrelated prompt.`,
        );
      }

      // Assert the agent was NOT triggered - this is the core validation.
      // If this fails, it indicates a false positive (overly broad triggers
      // or detection bug). The prompts are deliberately maximally unrelated.
      expect(result.triggered).toBe(false);
    }, 120000);
  });

  // Phase 2: Hook E2E tests
  // Tests hooks that fire without requiring disallowed tools (Write/Edit/Bash)
  // UserPromptSubmit fires on any user prompt, Stop fires when Claude completes
  //
  // NOTE: PreToolUse/PostToolUse hooks for Write|Edit|Bash are not tested here
  // because those tools are in disallowed_tools (helpers.ts). Future work could
  // add tool-specific config overrides to test those hooks. See #162 for context.
  describe("Hook Pipeline", () => {
    it("runs complete pipeline for hooks", async () => {
      const config = createE2EConfig({
        scope: { hooks: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Stage 1: Analysis
      const analysis = await runAnalysis(config);
      expect(analysis.components.hooks.length).toBeGreaterThan(0);

      // Stage 2: Generation (deterministic for hooks - zero LLM cost)
      const generation = await runGeneration(analysis, config);
      expect(generation.scenarios.length).toBeGreaterThan(0);

      // Verify hook scenarios were generated
      const hookScenarios = generation.scenarios.filter(
        (s) => s.component_type === "hook",
      );
      expect(hookScenarios.length).toBeGreaterThan(0);

      // Stage 3: Execution
      const execution = await runExecution(
        analysis,
        generation.scenarios,
        config,
        consoleProgress,
      );

      totalE2ECost += execution.total_cost_usd;
      e2eTestCount++;
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

      // Stage 4: Evaluation
      const evaluation = await runEvaluation(
        analysis.plugin_name,
        generation.scenarios,
        execution.results,
        config,
        consoleProgress,
      );

      // Verify evaluation completed
      expect(evaluation.metrics).toBeDefined();
      expect(evaluation.results.length).toBe(generation.scenarios.length);

      // Log hook results
      const hookResults = evaluation.results.filter(
        (r) =>
          generation.scenarios.find((s) => s.id === r.scenario_id)
            ?.component_type === "hook",
      );

      console.log(
        `\nE2E Hook Pipeline Complete:` +
          `\n  Hook scenarios: ${hookResults.length}` +
          `\n  Accuracy: ${(evaluation.metrics.accuracy * 100).toFixed(1)}%` +
          `\n  Total Cost: $${totalE2ECost.toFixed(4)}`,
      );
    }, 180000); // 3 min timeout for full 4-stage pipeline

    it("detects hook responses via SDKHookResponseMessage", async () => {
      const config = createE2EConfig({
        scope: { hooks: true },
        generation: { scenarios_per_component: 1 },
        execution: {
          max_turns: 2,
          max_budget_usd: 0.05,
        },
      });

      // Run stages 1-3
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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

      // Check if any hook responses were captured
      // Note: Hook response capture depends on which hooks fire during execution
      // UserPromptSubmit should fire on any prompt, Stop fires when Claude finishes
      const resultsWithHookResponses = execution.results.filter(
        (r) => r.hook_responses && r.hook_responses.length > 0,
      );

      // Log captured hook responses for visibility
      if (resultsWithHookResponses.length > 0) {
        const totalHookResponses = resultsWithHookResponses.reduce(
          (sum, r) => sum + (r.hook_responses?.length ?? 0),
          0,
        );
        console.log(
          `\nE2E Hook Detection:` +
            `\n  Scenarios with hook responses: ${resultsWithHookResponses.length}/${execution.results.length}` +
            `\n  Total hook responses captured: ${totalHookResponses}`,
        );

        // Log first few hook responses for debugging
        const firstResult = resultsWithHookResponses[0];
        if (firstResult?.hook_responses) {
          for (const hr of firstResult.hook_responses.slice(0, 3)) {
            console.log(
              `    - ${hr.hookEvent}: ${hr.hookName} (exit: ${hr.exitCode ?? "N/A"})`,
            );
          }
        }
      } else {
        console.log(
          `\nE2E Hook Detection:` +
            `\n  No hook responses captured (hooks may not have fired during execution)`,
        );
      }

      // The test validates the pipeline runs without error
      // Hook response capture is opportunistic based on Claude's behavior
      expect(execution.results.length).toBeGreaterThan(0);
    }, 120000); // 2 min timeout for stages 1-3 only (no evaluation)
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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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
      expect(isWithinPerTestBudget(execution.total_cost_usd)).toBe(true);

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

// =============================================================================
// Phase 3: MCP Server E2E Tests (Optional - requires RUN_E2E_MCP_TESTS=true)
// =============================================================================

/**
 * MCP Server E2E Tests
 *
 * These tests validate MCP server integration with the pipeline.
 * They are gated behind RUN_E2E_MCP_TESTS because:
 * - MCP server connections add significant startup latency (5-10s)
 * - External dependencies (npx, network) may cause flakiness
 * - Detection logic is deterministic and tested in unit tests
 *
 * Run with: RUN_E2E_TESTS=true RUN_E2E_MCP_TESTS=true npm test
 */
describeMcp("E2E: MCP Server Pipeline", () => {
  beforeAll(() => {
    validateE2EEnvironment();
  });

  it("runs complete pipeline for MCP servers", async () => {
    const config = createE2EConfig({
      scope: { mcp_servers: true },
      generation: { scenarios_per_component: 1 },
      execution: {
        max_turns: 3, // MCP tools may need extra turns
        max_budget_usd: 0.1, // Higher budget for MCP overhead
        timeout_ms: 120000, // Longer timeout for MCP server startup
      },
    });

    // Stage 1: Analysis
    const analysis = await runAnalysis(config);

    // Gracefully skip if no MCP servers in fixture (more resilient than failing)
    if (analysis.components.mcp_servers.length === 0) {
      console.log("Skipping MCP pipeline test: no MCP servers in test plugin");
      return;
    }

    // Log discovered MCP servers
    console.log(
      `\nMCP Servers discovered: ${analysis.components.mcp_servers.map((s) => s.name).join(", ")}`,
    );

    // Stage 2: Generation (deterministic for MCP - zero LLM cost)
    const generation = await runGeneration(analysis, config);
    expect(generation.scenarios.length).toBeGreaterThan(0);

    // Verify MCP scenarios were generated
    const mcpScenarios = generation.scenarios.filter(
      (s) => s.component_type === "mcp_server",
    );
    expect(mcpScenarios.length).toBeGreaterThan(0);

    console.log(`MCP scenarios generated: ${mcpScenarios.length}`);

    // Stage 3: Execution
    const execution = await runExecution(
      analysis,
      generation.scenarios,
      config,
      consoleProgress,
    );

    // Note: MCP tests don't share cost tracking with main E2E suite
    // since they run in a separate describe block
    expect(execution.results.length).toBeGreaterThan(0);

    // Stage 4: Evaluation
    const evaluation = await runEvaluation(
      analysis.plugin_name,
      generation.scenarios,
      execution.results,
      config,
      consoleProgress,
    );

    // Verify evaluation completed
    expect(evaluation.metrics).toBeDefined();
    expect(evaluation.results.length).toBe(generation.scenarios.length);

    // Check for MCP tool detections (pattern: mcp__<server>__<tool>)
    const mcpDetections = execution.results.flatMap((r) =>
      r.detected_tools.filter((t) => t.name.startsWith("mcp__")),
    );

    console.log(
      `\nE2E MCP Pipeline Complete:` +
        `\n  MCP servers: ${analysis.components.mcp_servers.length}` +
        `\n  Scenarios: ${generation.scenarios.length}` +
        `\n  MCP tool invocations: ${mcpDetections.length}` +
        `\n  Accuracy: ${(evaluation.metrics.accuracy * 100).toFixed(1)}%` +
        `\n  Cost: $${execution.total_cost_usd.toFixed(4)}`,
    );
  }, 300000); // 5 minute timeout for MCP tests

  // NOTE: This test validates pipeline execution succeeds, not that MCP tools are invoked.
  // MCP tool invocation is opportunistic - Claude decides whether to use MCP tools based
  // on the prompt. The test passes regardless of invocation count, logging results for
  // visibility. This is intentional to avoid flakiness from non-deterministic behavior.
  it("detects MCP tool invocations via mcp__server__tool pattern", async () => {
    const config = createE2EConfig({
      scope: { mcp_servers: true },
      generation: { scenarios_per_component: 1 },
      execution: {
        max_turns: 3,
        max_budget_usd: 0.1,
        timeout_ms: 120000,
      },
    });

    // Run stages 1-3
    const analysis = await runAnalysis(config);
    const generation = await runGeneration(analysis, config);
    const execution = await runExecution(
      analysis,
      generation.scenarios,
      config,
      consoleProgress,
    );

    // Analyze MCP tool usage across all results
    const allMcpTools: string[] = [];
    for (const result of execution.results) {
      for (const tool of result.detected_tools) {
        if (tool.name.startsWith("mcp__")) {
          allMcpTools.push(tool.name);
        }
      }
    }

    // Log MCP tool usage for visibility
    if (allMcpTools.length > 0) {
      const uniqueTools = [...new Set(allMcpTools)];
      console.log(
        `\nE2E MCP Tool Detection:` +
          `\n  Total MCP tool calls: ${allMcpTools.length}` +
          `\n  Unique tools: ${uniqueTools.length}`,
      );
      for (const tool of uniqueTools.slice(0, 5)) {
        // Parse tool name: mcp__<server>__<tool>
        const parts = tool.split("__");
        const server = parts[1] ?? "unknown";
        const toolName = parts[2] ?? "unknown";
        console.log(`    - ${server}: ${toolName}`);
      }
    } else {
      console.log(
        `\nE2E MCP Tool Detection:` +
          `\n  No MCP tools invoked (Claude may not have needed MCP tools for the prompts)`,
      );
    }

    // The test validates the pipeline runs without error
    // MCP tool invocation depends on Claude's decision to use MCP tools
    expect(execution.results.length).toBeGreaterThan(0);
  }, 300000);
});
