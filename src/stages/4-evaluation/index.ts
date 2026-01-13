/**
 * Stage 4: Evaluation
 *
 * Detect component activation and assess quality.
 * Combines programmatic detection (PRIMARY) with LLM judgment (SECONDARY).
 *
 * Detection Strategy:
 * 1. Programmatic detection parses tool captures for 100% confidence
 * 2. LLM judge assesses quality and handles edge cases
 * 3. Conflict analysis detects multiple component triggers
 *
 * Batching:
 * When total LLM judge calls >= batch_threshold, uses Anthropic Batches API
 * for 50% cost savings on asynchronous evaluation.
 *
 * Output: results/{plugin-name}/evaluation.json
 */

import Anthropic from "@anthropic-ai/sdk";

import { parallel } from "../../utils/concurrency.js";
import { ensureDir, getResultsDir, writeJson } from "../../utils/file-io.js";
import { logger } from "../../utils/logging.js";

import {
  shouldUseBatching,
  createEvaluationBatch,
  pollBatchCompletion,
  collectBatchResults,
  type BatchEvaluationRequest,
} from "./batch-evaluator.js";
import { calculateConflictSeverity } from "./conflict-tracker.js";
import { createErrorJudgeResponse } from "./llm-judge.js";
import {
  calculateEvalMetrics,
  createEmptyMetrics,
  formatMetrics,
} from "./metrics.js";
import { runJudgment } from "./multi-sampler.js";
import {
  detectAllComponents,
  detectAllComponentsWithHooks,
  getUniqueDetections,
  wasExpectedComponentTriggered,
  wasExpectedHookTriggered,
} from "./programmatic-detector.js";

import type {
  DetectionSource,
  EvalConfig,
  EvalMetrics,
  EvaluationResult,
  ExecutionResult,
  JudgeResponse,
  MultiSampleResult,
  ProgressCallbacks,
  TestScenario,
  TriggeredComponent,
} from "../../types/index.js";

/**
 * Output from Stage 4: Evaluation.
 */
export interface EvaluationOutput {
  plugin_name: string;
  results: EvaluationResult[];
  metrics: EvalMetrics;
  total_cost_usd: number;
  total_duration_ms: number;
}

/**
 * Scenario evaluation context.
 */
interface EvaluationContext {
  scenario: TestScenario;
  execution: ExecutionResult;
}

/**
 * Result of judge strategy determination.
 */
interface JudgeStrategy {
  needsLLMJudge: boolean;
  detectionSource: DetectionSource;
}

/**
 * Intermediate result from programmatic detection phase.
 */
interface ProgrammaticResult {
  context: EvaluationContext;
  uniqueDetections: ReturnType<typeof getUniqueDetections>;
  triggered: boolean;
  conflictAnalysis: ReturnType<typeof calculateConflictSeverity>;
  judgeStrategy: JudgeStrategy;
}

/**
 * Result from evaluating a single scenario.
 * Includes both the evaluation result and variance/consensus for metrics.
 */
interface ScenarioEvaluationResult {
  result: EvaluationResult;
  variance: number;
  /** Whether all samples agreed on trigger_accuracy */
  isUnanimous: boolean;
}

/**
 * Determine whether LLM judge should be used.
 *
 * @param scenario - Test scenario
 * @param triggered - Whether component was triggered
 * @param detectionMode - Detection mode from config
 * @returns Judge strategy
 */
function determineJudgeStrategy(
  scenario: TestScenario,
  triggered: boolean,
  detectionMode: "programmatic_first" | "llm_only",
): JudgeStrategy {
  // llm_only mode always uses LLM
  if (detectionMode === "llm_only") {
    return { needsLLMJudge: true, detectionSource: "llm" };
  }

  // programmatic_first mode decision tree
  const triggeredAsExpected = triggered && scenario.expected_trigger;
  const falseNegative = !triggered && scenario.expected_trigger;
  const isNonDirectScenario = scenario.scenario_type !== "direct";

  // Use LLM for quality assessment, false negatives, or non-direct scenarios
  if (triggeredAsExpected || falseNegative || isNonDirectScenario) {
    return { needsLLMJudge: true, detectionSource: "both" };
  }

  // True negatives with direct scenarios - programmatic is sufficient
  return { needsLLMJudge: false, detectionSource: "programmatic" };
}

/**
 * Build the evaluation result object.
 */
function buildEvaluationResult(
  scenario: TestScenario,
  triggered: boolean,
  uniqueDetections: ReturnType<typeof getUniqueDetections>,
  conflictAnalysis: ReturnType<typeof calculateConflictSeverity>,
  judgment: MultiSampleResult | null,
  detectionSource: DetectionSource,
): EvaluationResult {
  const allTriggeredComponents: TriggeredComponent[] = uniqueDetections.map(
    (d) => ({
      component_type: d.component_type,
      component_name: d.component_name,
      confidence: d.confidence,
    }),
  );

  const evidence = uniqueDetections.map((d) => d.evidence);

  // Use LLM quality score if available, otherwise infer from trigger correctness
  let qualityScore: number | null = null;
  if (judgment) {
    qualityScore = judgment.aggregated_score;
  } else if (triggered === scenario.expected_trigger) {
    qualityScore = triggered ? 7 : null;
  }

  const isCorrect = triggered === scenario.expected_trigger;

  return {
    scenario_id: scenario.id,
    triggered,
    confidence: uniqueDetections.length > 0 ? 100 : 0,
    quality_score: qualityScore,
    evidence,
    issues: judgment?.all_issues ?? [],
    summary:
      judgment?.representative_response.summary ??
      (isCorrect
        ? `Correctly ${triggered ? "triggered" : "did not trigger"} component`
        : `Incorrectly ${triggered ? "triggered" : "did not trigger"} component`),
    detection_source: detectionSource,
    all_triggered_components: allTriggeredComponents,
    has_conflict: conflictAnalysis.has_conflict,
    conflict_severity: conflictAnalysis.conflict_severity,
  };
}

/**
 * Run programmatic detection for a scenario.
 * Returns intermediate results needed for LLM judgment and final evaluation.
 */
function runProgrammaticDetection(
  context: EvaluationContext,
  detectionMode: "programmatic_first" | "llm_only",
): ProgrammaticResult {
  const { scenario, execution } = context;

  // Programmatic detection
  const detections =
    scenario.component_type === "hook"
      ? detectAllComponentsWithHooks(
          execution.detected_tools,
          execution.transcript,
          scenario,
          execution.hook_responses,
        )
      : detectAllComponents(
          execution.detected_tools,
          execution.transcript,
          scenario,
        );

  const uniqueDetections = getUniqueDetections(detections);

  // Check if expected component triggered
  const triggered =
    scenario.component_type === "hook"
      ? wasExpectedHookTriggered(
          execution.hook_responses ?? [],
          scenario.expected_component,
          scenario.component_ref.split("::")[0],
        )
      : wasExpectedComponentTriggered(
          uniqueDetections,
          scenario.expected_component,
          scenario.component_type,
        );

  // Conflict analysis
  const conflictAnalysis = calculateConflictSeverity(
    scenario.expected_component,
    scenario.component_type,
    uniqueDetections,
  );

  // Judge strategy
  const judgeStrategy = determineJudgeStrategy(
    scenario,
    triggered,
    detectionMode,
  );

  return {
    context,
    uniqueDetections,
    triggered,
    conflictAnalysis,
    judgeStrategy,
  };
}

/**
 * Build final evaluation result from programmatic result and optional judgment.
 */
function buildFinalResult(
  programmatic: ProgrammaticResult,
  judgment: MultiSampleResult | null,
): ScenarioEvaluationResult {
  const {
    context,
    triggered,
    uniqueDetections,
    conflictAnalysis,
    judgeStrategy,
  } = programmatic;

  const result = buildEvaluationResult(
    context.scenario,
    triggered,
    uniqueDetections,
    conflictAnalysis,
    judgment,
    judgeStrategy.detectionSource,
  );

  const variance = judgment?.score_variance ?? 0;
  const isUnanimous = judgment?.is_unanimous ?? true;

  return { result, variance, isUnanimous };
}

/**
 * Convert JudgeResponse to MultiSampleResult for compatibility.
 */
function judgeResponseToMultiSample(
  response: JudgeResponse,
): MultiSampleResult {
  return {
    individual_scores: [response.quality_score],
    aggregated_score: response.quality_score,
    score_variance: 0,
    consensus_trigger_accuracy: response.trigger_accuracy,
    is_unanimous: true,
    all_issues: response.issues,
    representative_response: response,
  };
}

/**
 * Run batched LLM evaluation using Anthropic Batches API.
 * Returns a map of scenario_id+sample to judgment results.
 */
async function runBatchedEvaluation(
  client: Anthropic,
  programmaticResults: ProgrammaticResult[],
  config: EvalConfig,
  _progress: ProgressCallbacks,
): Promise<Map<string, JudgeResponse>> {
  const { num_samples } = config.evaluation;

  // Collect all batch requests
  const batchRequests: BatchEvaluationRequest[] = [];
  for (const pr of programmaticResults) {
    if (!pr.judgeStrategy.needsLLMJudge) {
      continue;
    }

    for (let sampleIdx = 0; sampleIdx < num_samples; sampleIdx++) {
      batchRequests.push({
        scenario: pr.context.scenario,
        transcript: pr.context.execution.transcript,
        programmaticResult: pr.uniqueDetections,
        sampleIndex: sampleIdx,
      });
    }
  }

  if (batchRequests.length === 0) {
    return new Map();
  }

  logger.info(
    `Submitting ${String(batchRequests.length)} evaluation requests to Batches API (50% cost savings)`,
  );

  // Create batch
  const batchId = await createEvaluationBatch(
    client,
    batchRequests,
    config.evaluation,
  );
  logger.info(`Batch submitted: ${batchId}`);

  // Poll for completion
  const batch = await pollBatchCompletion(client, batchId, {
    pollIntervalMs: config.poll_interval_ms,
    timeoutMs: config.batch_timeout_ms,
    onProgress: (counts) => {
      const total =
        counts.processing +
        counts.succeeded +
        counts.errored +
        counts.canceled +
        counts.expired;
      logger.progress(
        counts.succeeded + counts.errored,
        total,
        `Batch processing: ${String(counts.succeeded)} succeeded, ${String(counts.errored)} errored`,
      );
    },
  });

  logger.success(
    `Batch complete: ${String(batch.request_counts.succeeded)} succeeded, ` +
      `${String(batch.request_counts.errored)} errored`,
  );

  // Collect results
  return collectBatchResults(client, batchId);
}

/**
 * Run synchronous LLM evaluation (original behavior).
 */
async function runSynchronousEvaluation(
  client: Anthropic,
  programmaticResults: ProgrammaticResult[],
  config: EvalConfig,
  progress: ProgressCallbacks,
  sampleData: {
    scenarioId: string;
    variance: number;
    numSamples: number;
    hasConsensus: boolean;
  }[],
): Promise<ScenarioEvaluationResult[]> {
  const evalConfig = config.evaluation;

  const parallelResult = await parallel<
    ProgrammaticResult,
    ScenarioEvaluationResult
  >({
    items: programmaticResults,
    concurrency: config.max_concurrent,
    fn: async (pr: ProgrammaticResult, index: number) => {
      let judgment: MultiSampleResult | null = null;

      if (pr.judgeStrategy.needsLLMJudge) {
        try {
          judgment = await runJudgment(
            client,
            pr.context.scenario,
            pr.context.execution.transcript,
            pr.uniqueDetections,
            evalConfig,
          );
        } catch (err) {
          const errorResponse = createErrorJudgeResponse(
            err instanceof Error ? err.message : String(err),
          );
          judgment = {
            individual_scores: [0],
            aggregated_score: 0,
            score_variance: 0,
            consensus_trigger_accuracy: "incorrect",
            is_unanimous: true,
            all_issues: errorResponse.issues,
            representative_response: errorResponse,
          };
        }
      }

      const evalResult = buildFinalResult(pr, judgment);

      // Track sample data if using multi-sampling
      if (config.evaluation.num_samples > 1 && judgment) {
        sampleData.push({
          scenarioId: evalResult.result.scenario_id,
          variance: evalResult.variance,
          numSamples: config.evaluation.num_samples,
          hasConsensus: evalResult.isUnanimous,
        });
      }

      logger.progress(
        index + 1,
        programmaticResults.length,
        `${evalResult.result.scenario_id}: ${evalResult.result.triggered ? "triggered" : "not triggered"}`,
      );

      return evalResult;
    },
    onError: (error: Error, pr: ProgrammaticResult) => {
      progress.onError?.(error, pr.context.scenario);
      logger.error(
        `Evaluation failed for ${pr.context.scenario.id}: ${error.message}`,
      );
    },
    continueOnError: true,
  });

  return (
    parallelResult.results as (ScenarioEvaluationResult | undefined)[]
  ).filter((r): r is ScenarioEvaluationResult => r !== undefined);
}

/**
 * Aggregate batch results into final evaluation results.
 *
 * @param programmaticResults - Results from programmatic detection
 * @param batchResults - Map of batch responses by custom ID
 * @param config - Evaluation configuration
 * @param sampleData - Array to track sample data for metrics
 * @returns Array of scenario evaluation results
 */
function aggregateBatchResults(
  programmaticResults: ProgrammaticResult[],
  batchResults: Map<string, JudgeResponse>,
  config: EvalConfig,
  sampleData: {
    scenarioId: string;
    variance: number;
    numSamples: number;
    hasConsensus: boolean;
  }[],
): ScenarioEvaluationResult[] {
  return programmaticResults.map((pr) => {
    if (!pr.judgeStrategy.needsLLMJudge) {
      return buildFinalResult(pr, null);
    }

    // Collect all sample results for this scenario
    const sampleResponses: JudgeResponse[] = [];
    for (
      let sampleIdx = 0;
      sampleIdx < config.evaluation.num_samples;
      sampleIdx++
    ) {
      const customId = `${pr.context.scenario.id}_sample-${String(sampleIdx)}`;
      const response = batchResults.get(customId);
      if (response) {
        sampleResponses.push(response);
      }
    }

    if (sampleResponses.length === 0) {
      // All samples failed
      const errorResponse = createErrorJudgeResponse(
        "No batch results received",
      );
      return buildFinalResult(pr, judgeResponseToMultiSample(errorResponse));
    }

    // Aggregate samples
    const scores = sampleResponses.map((r) => r.quality_score);
    const aggregatedScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const accuracyVotes = sampleResponses.map((r) => r.trigger_accuracy);
    const consensus = getMajorityVote(accuracyVotes);
    const isUnanimous = accuracyVotes.every((v) => v === accuracyVotes[0]);
    const variance = calculateVarianceFromScores(scores);

    // sampleResponses[0] is guaranteed to exist because sampleResponses.length > 0
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style
    const firstResponse = sampleResponses[0] as JudgeResponse;
    const multiSample: MultiSampleResult = {
      individual_scores: scores,
      aggregated_score: aggregatedScore,
      score_variance: variance,
      consensus_trigger_accuracy: consensus,
      is_unanimous: isUnanimous,
      all_issues: [...new Set(sampleResponses.flatMap((r) => r.issues))],
      representative_response: {
        ...firstResponse,
        quality_score: aggregatedScore,
        trigger_accuracy: consensus,
      },
    };

    // Track sample data
    if (config.evaluation.num_samples > 1) {
      sampleData.push({
        scenarioId: pr.context.scenario.id,
        variance,
        numSamples: config.evaluation.num_samples,
        hasConsensus: isUnanimous,
      });
    }

    return buildFinalResult(pr, multiSample);
  });
}

/**
 * Calculate metrics and save evaluation results.
 *
 * @param pluginName - Plugin name
 * @param resultsWithContext - Results with scenario and execution context
 * @param executions - Execution results
 * @param config - Evaluation configuration
 * @param sampleData - Sample data for multi-sampling metrics
 * @returns Calculated metrics
 */
function calculateAndSaveMetrics(
  pluginName: string,
  resultsWithContext: {
    result: EvaluationResult;
    scenario: TestScenario;
    execution: ExecutionResult;
  }[],
  executions: ExecutionResult[],
  config: EvalConfig,
  sampleData: {
    scenarioId: string;
    variance: number;
    numSamples: number;
    hasConsensus: boolean;
  }[],
): EvalMetrics {
  // Build metrics options
  const metricsOptions: {
    numSamples?: number;
    numReps?: number;
    sampleData?: typeof sampleData;
    flakyScenarios?: string[];
  } = {
    numSamples: config.evaluation.num_samples,
    numReps: config.execution.num_reps,
    flakyScenarios: [],
  };

  if (sampleData.length > 0) {
    metricsOptions.sampleData = sampleData;
  }

  const metrics = calculateEvalMetrics(
    resultsWithContext,
    executions,
    metricsOptions,
  );

  // Log metrics summary
  logger.info(formatMetrics(metrics));

  // Save evaluation results
  const results = resultsWithContext.map((r) => r.result);
  saveEvaluationResults(pluginName, results, metrics, config);

  return metrics;
}

/**
 * Run Stage 4: Evaluation.
 *
 * @param pluginName - Plugin name
 * @param scenarios - Test scenarios
 * @param executions - Execution results
 * @param config - Evaluation configuration
 * @param progress - Progress callbacks
 * @returns Evaluation output
 */
export async function runEvaluation(
  pluginName: string,
  scenarios: TestScenario[],
  executions: ExecutionResult[],
  config: EvalConfig,
  progress: ProgressCallbacks = {},
): Promise<EvaluationOutput> {
  logger.stageHeader("Stage 4: Evaluation", executions.length);

  const startTime = Date.now();

  // Handle empty executions
  if (executions.length === 0) {
    logger.warn("No executions to evaluate");
    return {
      plugin_name: pluginName,
      results: [],
      metrics: createEmptyMetrics(),
      total_cost_usd: 0,
      total_duration_ms: Date.now() - startTime,
    };
  }

  // Create Anthropic client for LLM judge
  const client = new Anthropic({ maxRetries: 0 });

  // Build scenario map for quick lookup
  const scenarioMap = new Map<string, TestScenario>();
  for (const scenario of scenarios) {
    scenarioMap.set(scenario.id, scenario);
  }

  // Build evaluation contexts
  const contexts: EvaluationContext[] = [];
  for (const execution of executions) {
    const scenario = scenarioMap.get(execution.scenario_id);
    if (scenario) {
      contexts.push({ scenario, execution });
    } else {
      logger.warn(`No scenario found for execution: ${execution.scenario_id}`);
    }
  }

  progress.onStageStart?.("evaluation", contexts.length);

  // Phase 1: Run programmatic detection for all scenarios
  logger.info("Running programmatic detection...");
  const programmaticResults = contexts.map((ctx) =>
    runProgrammaticDetection(ctx, config.evaluation.detection_mode),
  );

  // Count total LLM judge calls needed
  const scenariosNeedingJudge = programmaticResults.filter(
    (pr) => pr.judgeStrategy.needsLLMJudge,
  ).length;
  const totalJudgeCalls = scenariosNeedingJudge * config.evaluation.num_samples;

  // Determine if batching should be used
  const useBatching = shouldUseBatching({
    totalJudgeCalls,
    batchThreshold: config.batch_threshold,
    forceSynchronous: config.force_synchronous,
  });

  // Track sample data for metrics
  const sampleData: {
    scenarioId: string;
    variance: number;
    numSamples: number;
    hasConsensus: boolean;
  }[] = [];

  let evalResults: ScenarioEvaluationResult[];

  if (useBatching) {
    logger.info(
      `Using Batches API for ${String(totalJudgeCalls)} judge calls (threshold: ${String(config.batch_threshold)})`,
    );

    // Phase 2a: Run batched LLM evaluation
    const batchResults = await runBatchedEvaluation(
      client,
      programmaticResults,
      config,
      progress,
    );

    // Phase 3a: Build final results using batch responses
    evalResults = aggregateBatchResults(
      programmaticResults,
      batchResults,
      config,
      sampleData,
    );
  } else {
    logger.info(
      `Using synchronous evaluation for ${String(totalJudgeCalls)} judge calls ` +
        `(below threshold: ${String(config.batch_threshold)})`,
    );

    // Phase 2b: Run synchronous LLM evaluation
    evalResults = await runSynchronousEvaluation(
      client,
      programmaticResults,
      config,
      progress,
      sampleData,
    );
  }

  const results = evalResults.map((r) => r.result);

  // Build results with context for metrics
  const resultsWithContext = results.map((result) => {
    const context = contexts.find((c) => c.scenario.id === result.scenario_id);
    return {
      result,
      scenario: context?.scenario ?? ({} as TestScenario),
      execution: context?.execution ?? ({} as ExecutionResult),
    };
  });

  // Calculate metrics and save results
  const metrics = calculateAndSaveMetrics(
    pluginName,
    resultsWithContext,
    executions,
    config,
    sampleData,
  );

  const totalDuration = Date.now() - startTime;

  logger.success(
    `Evaluation complete: ${String(results.length)} scenarios evaluated`,
  );
  progress.onStageComplete?.("evaluation", totalDuration, results.length);

  return {
    plugin_name: pluginName,
    results,
    metrics,
    total_cost_usd: metrics.total_cost_usd,
    total_duration_ms: totalDuration,
  };
}

/**
 * Get majority vote for trigger accuracy.
 */
function getMajorityVote(
  votes: ("correct" | "incorrect" | "partial")[],
): "correct" | "incorrect" | "partial" {
  if (votes.length === 0) {
    return "incorrect";
  }
  const counts = { correct: 0, incorrect: 0, partial: 0 };
  for (const v of votes) {
    counts[v]++;
  }
  let maxKey: keyof typeof counts = "incorrect";
  let maxCount = 0;
  for (const [key, count] of Object.entries(counts) as [
    keyof typeof counts,
    number,
  ][]) {
    if (count > maxCount) {
      maxCount = count;
      maxKey = key;
    }
  }
  return maxKey;
}

/**
 * Calculate variance from scores.
 */
function calculateVarianceFromScores(scores: number[]): number {
  if (scores.length === 0) {
    return 0;
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return (
    scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length
  );
}

/**
 * Save evaluation results to disk.
 *
 * @param pluginName - Plugin name
 * @param results - Evaluation results
 * @param metrics - Evaluation metrics
 * @param config - Configuration
 */
function saveEvaluationResults(
  pluginName: string,
  results: EvaluationResult[],
  metrics: EvalMetrics,
  config: EvalConfig,
): void {
  const resultsDir = getResultsDir(pluginName);
  ensureDir(resultsDir);

  const evaluationPath = `${resultsDir}/evaluation.json`;

  const output = {
    plugin_name: pluginName,
    timestamp: new Date().toISOString(),
    config: {
      detection_mode: config.evaluation.detection_mode,
      num_samples: config.evaluation.num_samples,
      aggregate_method: config.evaluation.aggregate_method,
      model: config.evaluation.model,
    },
    metrics,
    results,
  };

  writeJson(evaluationPath, output);
  logger.info(`Saved evaluation results to ${evaluationPath}`);
}

// Re-export components for direct use
export {
  detectAllComponents,
  detectAllComponentsWithHooks,
  detectFromCaptures,
  detectFromTranscript,
  detectDirectCommandInvocation,
  wasExpectedComponentTriggered,
  wasExpectedHookTriggered,
  getUniqueDetections,
} from "./programmatic-detector.js";

export {
  calculateConflictSeverity,
  sharesDomain,
  countConflicts,
  getConflictSummary,
} from "./conflict-tracker.js";

export {
  evaluateWithLLMJudge,
  evaluateWithFallback,
  buildJudgePrompt,
  formatTranscriptWithIds,
  createErrorJudgeResponse,
} from "./llm-judge.js";

export {
  evaluateWithMultiSampling,
  evaluateSingleSample,
  runJudgment,
  aggregateScores,
  calculateVariance,
  getMajorityVote,
  isUnanimousVote,
} from "./multi-sampler.js";

export {
  calculateEvalMetrics,
  calculateTriggerRate,
  calculateAccuracy,
  calculateAvgQuality,
  calculateComponentMetrics,
  formatMetrics,
  createEmptyMetrics,
} from "./metrics.js";

export {
  shouldUseBatching,
  createBatchRequests,
  createEvaluationBatch,
  pollBatchCompletion,
  collectBatchResults,
  cancelBatch,
  parseCustomId,
  type BatchEvaluationRequest,
  type BatchingOptions,
  type PollOptions,
} from "./batch-evaluator.js";
