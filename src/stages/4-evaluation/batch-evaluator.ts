/**
 * Batch Evaluator - Anthropic Batches API integration for Stage 4.
 *
 * Provides 50% cost savings by using Anthropic's Batches API for
 * asynchronous LLM judge evaluations. Batching is used when the
 * total number of judge calls exceeds the configured threshold.
 *
 * Features:
 * - Batch request creation from evaluation contexts
 * - Polling with exponential backoff and timeout
 * - Result collection and parsing
 * - Graceful degradation on failures
 */

import { sleep } from "../../utils/retry.js";
import { resolveModelId } from "../2-generation/cost-estimator.js";

import { buildJudgePrompt } from "./llm-judge.js";

import type {
  EvaluationConfig,
  JudgeResponse,
  ProgrammaticDetection,
  TestScenario,
  Transcript,
} from "../../types/index.js";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Batch evaluation request.
 * Contains all data needed to create a judge prompt for the batch.
 */
export interface BatchEvaluationRequest {
  /** Test scenario being evaluated */
  scenario: TestScenario;
  /** Execution transcript */
  transcript: Transcript;
  /** Programmatic detection results */
  programmaticResult: ProgrammaticDetection[];
  /** Sample index for multi-sampling (0 for single sample) */
  sampleIndex: number;
}

/**
 * Options for determining if batching should be used.
 */
export interface BatchingOptions {
  /** Total number of judge API calls needed */
  totalJudgeCalls: number;
  /** Minimum calls before batching kicks in */
  batchThreshold: number;
  /** Force synchronous execution */
  forceSynchronous: boolean;
}

/**
 * Options for polling batch completion.
 */
export interface PollOptions {
  /** Interval between polls in milliseconds */
  pollIntervalMs: number;
  /** Maximum time to wait for batch completion in milliseconds */
  timeoutMs: number;
  /** Optional callback for progress updates */
  onProgress?: (
    counts: Anthropic.Messages.Batches.MessageBatchRequestCounts,
  ) => void;
}

/**
 * Batch request as expected by Anthropic API.
 */
export interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    messages: { role: "user"; content: string }[];
  };
}

/**
 * Determine if batching should be used based on configuration and request count.
 *
 * Batching is used when:
 * 1. Total judge calls >= batch_threshold
 * 2. force_synchronous is not set
 *
 * @param options - Batching configuration options
 * @returns True if batching should be used
 *
 * @example
 * ```typescript
 * const useBatching = shouldUseBatching({
 *   totalJudgeCalls: 100, // scenarios × num_samples
 *   batchThreshold: 50,
 *   forceSynchronous: false,
 * });
 *
 * if (useBatching) {
 *   // Use batch API for 50% cost savings
 * }
 * ```
 */
export function shouldUseBatching(options: BatchingOptions): boolean {
  const { totalJudgeCalls, batchThreshold, forceSynchronous } = options;

  if (forceSynchronous) {
    return false;
  }

  return totalJudgeCalls >= batchThreshold;
}

/**
 * Create a unique custom_id for a batch request.
 *
 * @param scenarioId - Scenario ID
 * @param sampleIndex - Sample index for multi-sampling
 * @returns Unique custom_id
 */
function createCustomId(scenarioId: string, sampleIndex: number): string {
  return `${scenarioId}_sample-${String(sampleIndex)}`;
}

/**
 * Parse custom_id back to scenario ID and sample index.
 *
 * @param customId - Custom ID to parse
 * @returns Parsed components or null if invalid
 */
export function parseCustomId(
  customId: string,
): { scenarioId: string; sampleIndex: number } | null {
  const match = /^(.+)_sample-(\d+)$/.exec(customId);
  if (!match) {
    return null;
  }

  const scenarioId = match[1];
  const sampleIndex = parseInt(match[2] ?? "0", 10);

  if (scenarioId === undefined || isNaN(sampleIndex)) {
    return null;
  }

  return { scenarioId, sampleIndex };
}

/**
 * Create batch requests from evaluation requests.
 *
 * Converts evaluation contexts into Anthropic batch request format.
 * Each request includes the judge prompt and model configuration.
 *
 * @param requests - Batch evaluation requests
 * @param config - Evaluation configuration
 * @returns Array of batch requests
 *
 * @example
 * ```typescript
 * const batchRequests = createBatchRequests(evaluationRequests, config);
 * const batch = await client.messages.batches.create({ requests: batchRequests });
 * ```
 */
export function createBatchRequests(
  requests: BatchEvaluationRequest[],
  config: EvaluationConfig,
): BatchRequest[] {
  return requests.map((req) => {
    const prompt = buildJudgePrompt(
      req.scenario,
      req.transcript,
      req.programmaticResult,
      config,
    );

    return {
      custom_id: createCustomId(req.scenario.id, req.sampleIndex),
      params: {
        model: resolveModelId(config.model),
        max_tokens: config.max_tokens,
        messages: [{ role: "user" as const, content: prompt }],
      },
    };
  });
}

/**
 * Create an evaluation batch via Anthropic Batches API.
 *
 * Submits all evaluation requests as a single batch for asynchronous processing.
 * Returns the batch ID for polling and result collection.
 *
 * @param client - Anthropic client
 * @param requests - Batch evaluation requests
 * @param config - Evaluation configuration
 * @returns Batch ID
 *
 * @example
 * ```typescript
 * const batchId = await createEvaluationBatch(client, requests, config);
 * console.log(`Submitted batch: ${batchId}`);
 *
 * // Poll for completion
 * const batch = await pollBatchCompletion(client, batchId, { ... });
 * ```
 */
export async function createEvaluationBatch(
  client: Anthropic,
  requests: BatchEvaluationRequest[],
  config: EvaluationConfig,
): Promise<string> {
  const batchRequests = createBatchRequests(requests, config);

  const batch = await client.messages.batches.create({
    requests: batchRequests,
  });

  return batch.id;
}

/**
 * Poll for batch completion with timeout.
 *
 * Polls the batch status at regular intervals until processing ends.
 * Uses exponential backoff up to the poll interval.
 *
 * @param client - Anthropic client
 * @param batchId - Batch ID to poll
 * @param options - Poll options
 * @returns Completed batch status
 * @throws Error if timeout is reached
 *
 * @example
 * ```typescript
 * const batch = await pollBatchCompletion(client, batchId, {
 *   pollIntervalMs: 30000,
 *   timeoutMs: 1800000, // 30 minutes
 *   onProgress: (counts) => console.log(`Progress: ${counts.succeeded}/${total}`),
 * });
 * ```
 */
export async function pollBatchCompletion(
  client: Anthropic,
  batchId: string,
  options: PollOptions,
): Promise<Anthropic.Messages.Batches.MessageBatch> {
  const { pollIntervalMs, timeoutMs, onProgress } = options;
  const startTime = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Infinite loop is intentional
  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);

    // Report progress
    onProgress?.(batch.request_counts);

    // Check if batch is complete
    if (batch.processing_status === "ended") {
      return batch;
    }

    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Batch ${batchId} timeout after ${String(elapsed)}ms - still ${batch.processing_status}`,
      );
    }

    // Wait before next poll
    await sleep(pollIntervalMs);
  }
}

/**
 * Parse judge response from batch result text.
 *
 * @param text - JSON text from batch result
 * @returns Parsed judge response
 */
function parseJudgeResponse(text: string): JudgeResponse {
  const parsed = JSON.parse(text) as {
    quality_score: number;
    response_relevance: number;
    trigger_accuracy: "correct" | "incorrect" | "partial";
    issues: string[];
    highlights?: {
      description: string;
      message_id: string;
      quoted_text: string;
      position_start?: number;
      position_end?: number;
    }[];
    summary: string;
  };

  // Transform highlights to expected format
  const highlights = parsed.highlights?.map((h) => ({
    description: h.description,
    citation: {
      message_id: h.message_id,
      quoted_text: h.quoted_text,
      position: [h.position_start ?? 0, h.position_end ?? 0] as [
        number,
        number,
      ],
    },
  }));

  const result: JudgeResponse = {
    quality_score: parsed.quality_score,
    response_relevance: parsed.response_relevance,
    trigger_accuracy: parsed.trigger_accuracy,
    issues: parsed.issues,
    summary: parsed.summary,
  };

  // Only add highlights if present
  if (highlights !== undefined) {
    result.highlights = highlights;
  }

  return result;
}

/**
 * Create an error judge response for failed batch requests.
 *
 * @param error - Error message
 * @returns Default judge response indicating failure
 */
function createErrorResponse(error: string): JudgeResponse {
  return {
    quality_score: 0,
    response_relevance: 0,
    trigger_accuracy: "incorrect",
    issues: [error],
    summary: `Batch evaluation failed: ${error}`,
  };
}

/**
 * Collect and parse batch results.
 *
 * Iterates through batch results and parses each judge response.
 * Handles succeeded, errored, canceled, and expired results.
 *
 * @param client - Anthropic client
 * @param batchId - Batch ID to collect results from
 * @returns Map of custom_id to parsed judge response
 *
 * @example
 * ```typescript
 * const results = await collectBatchResults(client, batchId);
 *
 * for (const [customId, response] of results) {
 *   const { scenarioId, sampleIndex } = parseCustomId(customId);
 *   console.log(`${scenarioId} sample ${sampleIndex}: ${response.quality_score}`);
 * }
 * ```
 */
export async function collectBatchResults(
  client: Anthropic,
  batchId: string,
): Promise<Map<string, JudgeResponse>> {
  const results = new Map<string, JudgeResponse>();

  const resultsIterator = await client.messages.batches.results(batchId);

  for await (const item of resultsIterator) {
    const customId = item.custom_id;

    switch (item.result.type) {
      case "succeeded": {
        const textBlock = item.result.message.content.find(
          (block) => block.type === "text",
        );
        if (textBlock?.type !== "text") {
          results.set(
            customId,
            createErrorResponse("No text block in batch response"),
          );
          break;
        }

        try {
          const response = parseJudgeResponse(textBlock.text);
          results.set(customId, response);
        } catch (err) {
          results.set(
            customId,
            createErrorResponse(
              `Failed to parse judge response: ${String(err)}`,
            ),
          );
        }
        break;
      }

      case "errored": {
        const errorType = item.result.error.type;
        results.set(
          customId,
          createErrorResponse(`Batch request failed: ${errorType}`),
        );
        break;
      }

      case "canceled": {
        results.set(
          customId,
          createErrorResponse("Batch request was canceled"),
        );
        break;
      }

      case "expired": {
        results.set(customId, createErrorResponse("Batch request expired"));
        break;
      }
    }
  }

  return results;
}

/**
 * Cancel a batch that is in progress.
 *
 * Use this for graceful shutdown when a pipeline is interrupted.
 * Note: Some requests may still complete after cancellation is initiated.
 *
 * @param client - Anthropic client
 * @param batchId - Batch ID to cancel
 * @returns Updated batch status
 */
export async function cancelBatch(
  client: Anthropic,
  batchId: string,
): Promise<Anthropic.Messages.Batches.MessageBatch> {
  return client.messages.batches.cancel(batchId);
}
