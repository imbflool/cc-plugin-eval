/**
 * Tests for batch evaluator functions.
 *
 * Uses mocked Anthropic SDK to test batch API integration.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type {
  EvaluationConfig,
  ProgrammaticDetection,
  TestScenario,
  Transcript,
} from "../../../../src/types/index.js";

import {
  createBatchRequests,
  createEvaluationBatch,
  pollBatchCompletion,
  collectBatchResults,
  shouldUseBatching,
  parseCustomId,
  type BatchEvaluationRequest,
} from "../../../../src/stages/4-evaluation/batch-evaluator.js";

// Mock the retry utility to avoid delays in tests
vi.mock("../../../../src/utils/retry.js", () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Create a mock Anthropic client with batches API.
 */
function createMockClient(): Anthropic & {
  messages: {
    batches: {
      create: Mock;
      retrieve: Mock;
      results: Mock;
      cancel: Mock;
    };
  };
} {
  return {
    messages: {
      batches: {
        create: vi.fn(),
        retrieve: vi.fn(),
        results: vi.fn(),
        cancel: vi.fn(),
      },
    },
  } as unknown as Anthropic & {
    messages: {
      batches: {
        create: Mock;
        retrieve: Mock;
        results: Mock;
        cancel: Mock;
      };
    };
  };
}

/**
 * Create a mock test scenario.
 */
function createScenario(overrides: Partial<TestScenario> = {}): TestScenario {
  return {
    id: "test-scenario-1",
    component_ref: "test-skill",
    component_type: "skill",
    scenario_type: "direct",
    user_prompt: "Help me commit my changes",
    expected_trigger: true,
    expected_component: "commit",
    ...overrides,
  };
}

/**
 * Create a mock transcript.
 */
function createTranscript(
  scenarioId = "test-scenario-1",
  pluginName = "test-plugin",
): Transcript {
  return {
    metadata: {
      version: "v3.0",
      plugin_name: pluginName,
      scenario_id: scenarioId,
      timestamp: new Date().toISOString(),
      model: "claude-sonnet-4-20250514",
    },
    events: [
      {
        id: "msg-1",
        type: "user",
        edit: {
          message: { role: "user", content: "Help me commit my changes" },
        },
      },
      {
        id: "msg-2",
        type: "assistant",
        edit: {
          message: {
            role: "assistant",
            content: "I'll help you commit your changes.",
            tool_calls: [
              { id: "tc-1", name: "Skill", input: { skill: "commit" } },
            ],
          },
        },
      },
    ],
  };
}

/**
 * Create mock programmatic detections.
 */
function createDetections(): ProgrammaticDetection[] {
  return [
    {
      component_type: "skill",
      component_name: "commit",
      confidence: 100 as const,
      tool_name: "Skill",
      evidence: "skill triggered: commit",
      timestamp: Date.now(),
    },
  ];
}

/**
 * Create mock evaluation config.
 */
function createConfig(
  overrides: Partial<EvaluationConfig> = {},
): EvaluationConfig {
  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 4000,
    detection_mode: "programmatic_first",
    reasoning_effort: "low",
    num_samples: 1,
    aggregate_method: "average",
    include_citations: true,
    ...overrides,
  };
}

/**
 * Create batch evaluation requests.
 */
function createBatchEvaluationRequests(
  count: number,
): BatchEvaluationRequest[] {
  return Array.from({ length: count }, (_, i) => ({
    scenario: createScenario({ id: `scenario-${i}` }),
    transcript: createTranscript(`scenario-${i}`),
    programmaticResult: createDetections(),
    sampleIndex: 0,
  }));
}

/**
 * Create a valid judge response JSON string.
 */
function createJudgeResponseJson(
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    quality_score: 8,
    response_relevance: 9,
    trigger_accuracy: "correct",
    issues: [],
    highlights: [],
    summary: "The component triggered correctly.",
    ...overrides,
  });
}

describe("shouldUseBatching", () => {
  it("should return true when above threshold and not forced synchronous", () => {
    const result = shouldUseBatching({
      totalJudgeCalls: 100,
      batchThreshold: 50,
      forceSynchronous: false,
    });

    expect(result).toBe(true);
  });

  it("should return false when below threshold", () => {
    const result = shouldUseBatching({
      totalJudgeCalls: 30,
      batchThreshold: 50,
      forceSynchronous: false,
    });

    expect(result).toBe(false);
  });

  it("should return false when forced synchronous", () => {
    const result = shouldUseBatching({
      totalJudgeCalls: 100,
      batchThreshold: 50,
      forceSynchronous: true,
    });

    expect(result).toBe(false);
  });

  it("should return true at exact threshold", () => {
    const result = shouldUseBatching({
      totalJudgeCalls: 50,
      batchThreshold: 50,
      forceSynchronous: false,
    });

    expect(result).toBe(true);
  });

  it("should calculate total calls including multi-sampling", () => {
    // 30 scenarios × 2 samples = 60 calls
    const result = shouldUseBatching({
      totalJudgeCalls: 60,
      batchThreshold: 50,
      forceSynchronous: false,
    });

    expect(result).toBe(true);
  });
});

describe("createBatchRequests", () => {
  it("should create batch request for each evaluation", () => {
    const requests = createBatchEvaluationRequests(3);
    const config = createConfig();

    const batchRequests = createBatchRequests(requests, config);

    expect(batchRequests).toHaveLength(3);
    expect(batchRequests[0]?.custom_id).toBe("scenario-0_sample-0");
    expect(batchRequests[1]?.custom_id).toBe("scenario-1_sample-0");
    expect(batchRequests[2]?.custom_id).toBe("scenario-2_sample-0");
  });

  it("should include model and max_tokens in params", () => {
    const requests = createBatchEvaluationRequests(1);
    const config = createConfig({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
    });

    const batchRequests = createBatchRequests(requests, config);

    expect(batchRequests[0]?.params.model).toBe("claude-sonnet-4-5-20250929");
    expect(batchRequests[0]?.params.max_tokens).toBe(2048);
  });

  it("should include user message with judge prompt", () => {
    const requests = createBatchEvaluationRequests(1);
    const config = createConfig();

    const batchRequests = createBatchRequests(requests, config);

    expect(batchRequests[0]?.params.messages).toHaveLength(1);
    expect(batchRequests[0]?.params.messages[0]?.role).toBe("user");
    expect(batchRequests[0]?.params.messages[0]?.content).toContain("PLUGIN:");
  });

  it("should handle multi-sample requests", () => {
    const request: BatchEvaluationRequest = {
      scenario: createScenario({ id: "scenario-1" }),
      transcript: createTranscript("scenario-1"),
      programmaticResult: createDetections(),
      sampleIndex: 2,
    };
    const config = createConfig();

    const batchRequests = createBatchRequests([request], config);

    expect(batchRequests[0]?.custom_id).toBe("scenario-1_sample-2");
  });
});

describe("createEvaluationBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should call batches.create with requests", async () => {
    const mockClient = createMockClient();
    mockClient.messages.batches.create.mockResolvedValue({
      id: "batch_abc123",
      processing_status: "in_progress",
      request_counts: {
        processing: 3,
        succeeded: 0,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
    });

    const requests = createBatchEvaluationRequests(3);
    const config = createConfig();

    const batchId = await createEvaluationBatch(mockClient, requests, config);

    expect(batchId).toBe("batch_abc123");
    expect(mockClient.messages.batches.create).toHaveBeenCalledTimes(1);
    const callArgs = mockClient.messages.batches.create.mock.calls[0]?.[0];
    expect(callArgs?.requests).toHaveLength(3);
  });

  it("should throw on API error", async () => {
    const mockClient = createMockClient();
    mockClient.messages.batches.create.mockRejectedValue(
      new Error("API error"),
    );

    const requests = createBatchEvaluationRequests(1);
    const config = createConfig();

    await expect(
      createEvaluationBatch(mockClient, requests, config),
    ).rejects.toThrow("API error");
  });
});

describe("pollBatchCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return immediately when batch is already ended", async () => {
    const mockClient = createMockClient();
    mockClient.messages.batches.retrieve.mockResolvedValue({
      id: "batch_abc123",
      processing_status: "ended",
      request_counts: {
        processing: 0,
        succeeded: 5,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
    });

    const result = await pollBatchCompletion(mockClient, "batch_abc123", {
      pollIntervalMs: 1000,
      timeoutMs: 60000,
    });

    expect(result.processing_status).toBe("ended");
    expect(mockClient.messages.batches.retrieve).toHaveBeenCalledTimes(1);
  });

  it("should poll until batch ends", async () => {
    const mockClient = createMockClient();
    mockClient.messages.batches.retrieve
      .mockResolvedValueOnce({
        id: "batch_abc123",
        processing_status: "in_progress",
        request_counts: {
          processing: 5,
          succeeded: 0,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      })
      .mockResolvedValueOnce({
        id: "batch_abc123",
        processing_status: "in_progress",
        request_counts: {
          processing: 2,
          succeeded: 3,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      })
      .mockResolvedValueOnce({
        id: "batch_abc123",
        processing_status: "ended",
        request_counts: {
          processing: 0,
          succeeded: 5,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      });

    const result = await pollBatchCompletion(mockClient, "batch_abc123", {
      pollIntervalMs: 100,
      timeoutMs: 60000,
    });

    expect(result.processing_status).toBe("ended");
    expect(mockClient.messages.batches.retrieve).toHaveBeenCalledTimes(3);
  });

  it("should throw on timeout", async () => {
    const mockClient = createMockClient();
    mockClient.messages.batches.retrieve.mockResolvedValue({
      id: "batch_abc123",
      processing_status: "in_progress",
      request_counts: {
        processing: 5,
        succeeded: 0,
        errored: 0,
        canceled: 0,
        expired: 0,
      },
    });

    await expect(
      pollBatchCompletion(mockClient, "batch_abc123", {
        pollIntervalMs: 100,
        timeoutMs: 250, // Will timeout after ~2 polls
      }),
    ).rejects.toThrow("timeout");
  });

  it("should call onProgress callback", async () => {
    const mockClient = createMockClient();
    mockClient.messages.batches.retrieve
      .mockResolvedValueOnce({
        id: "batch_abc123",
        processing_status: "in_progress",
        request_counts: {
          processing: 3,
          succeeded: 2,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      })
      .mockResolvedValueOnce({
        id: "batch_abc123",
        processing_status: "ended",
        request_counts: {
          processing: 0,
          succeeded: 5,
          errored: 0,
          canceled: 0,
          expired: 0,
        },
      });

    const onProgress = vi.fn();

    await pollBatchCompletion(mockClient, "batch_abc123", {
      pollIntervalMs: 100,
      timeoutMs: 60000,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith({
      processing: 3,
      succeeded: 2,
      errored: 0,
      canceled: 0,
      expired: 0,
    });
    expect(onProgress).toHaveBeenCalledWith({
      processing: 0,
      succeeded: 5,
      errored: 0,
      canceled: 0,
      expired: 0,
    });
  });
});

describe("collectBatchResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should collect and parse successful results", async () => {
    const mockClient = createMockClient();
    const mockResults = [
      {
        custom_id: "scenario-0_sample-0",
        result: {
          type: "succeeded",
          message: {
            content: [
              {
                type: "text",
                text: createJudgeResponseJson({ quality_score: 8 }),
              },
            ],
          },
        },
      },
      {
        custom_id: "scenario-1_sample-0",
        result: {
          type: "succeeded",
          message: {
            content: [
              {
                type: "text",
                text: createJudgeResponseJson({ quality_score: 9 }),
              },
            ],
          },
        },
      },
    ];

    // Mock async iterator for JSONL results
    mockClient.messages.batches.results.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const result of mockResults) {
          yield result;
        }
      },
    });

    const results = await collectBatchResults(mockClient, "batch_abc123");

    expect(results.size).toBe(2);
    expect(results.get("scenario-0_sample-0")?.quality_score).toBe(8);
    expect(results.get("scenario-1_sample-0")?.quality_score).toBe(9);
  });

  it("should handle errored results", async () => {
    const mockClient = createMockClient();
    const mockResults = [
      {
        custom_id: "scenario-0_sample-0",
        result: {
          type: "errored",
          error: { type: "api_error", message: "Internal server error" },
        },
      },
    ];

    mockClient.messages.batches.results.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const result of mockResults) {
          yield result;
        }
      },
    });

    const results = await collectBatchResults(mockClient, "batch_abc123");

    expect(results.size).toBe(1);
    const errorResult = results.get("scenario-0_sample-0");
    expect(errorResult?.quality_score).toBe(0);
    expect(errorResult?.trigger_accuracy).toBe("incorrect");
    expect(errorResult?.issues).toContain("Batch request failed: api_error");
  });

  it("should handle canceled results", async () => {
    const mockClient = createMockClient();
    const mockResults = [
      {
        custom_id: "scenario-0_sample-0",
        result: { type: "canceled" },
      },
    ];

    mockClient.messages.batches.results.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const result of mockResults) {
          yield result;
        }
      },
    });

    const results = await collectBatchResults(mockClient, "batch_abc123");

    expect(results.size).toBe(1);
    const canceledResult = results.get("scenario-0_sample-0");
    expect(canceledResult?.quality_score).toBe(0);
    expect(canceledResult?.issues).toContain("Batch request was canceled");
  });

  it("should handle expired results", async () => {
    const mockClient = createMockClient();
    const mockResults = [
      {
        custom_id: "scenario-0_sample-0",
        result: { type: "expired" },
      },
    ];

    mockClient.messages.batches.results.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const result of mockResults) {
          yield result;
        }
      },
    });

    const results = await collectBatchResults(mockClient, "batch_abc123");

    expect(results.size).toBe(1);
    const expiredResult = results.get("scenario-0_sample-0");
    expect(expiredResult?.quality_score).toBe(0);
    expect(expiredResult?.issues).toContain("Batch request expired");
  });

  it("should handle malformed JSON in successful result", async () => {
    const mockClient = createMockClient();
    const mockResults = [
      {
        custom_id: "scenario-0_sample-0",
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: "not valid json" }],
          },
        },
      },
    ];

    mockClient.messages.batches.results.mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const result of mockResults) {
          yield result;
        }
      },
    });

    const results = await collectBatchResults(mockClient, "batch_abc123");

    expect(results.size).toBe(1);
    const parseErrorResult = results.get("scenario-0_sample-0");
    expect(parseErrorResult?.quality_score).toBe(0);
    expect(
      parseErrorResult?.issues.some((i) => i.includes("Failed to parse")),
    ).toBe(true);
  });
});

describe("parseCustomId", () => {
  it("should parse valid custom_id format", () => {
    const result = parseCustomId("scenario-123_sample-0");

    expect(result).toEqual({
      scenarioId: "scenario-123",
      sampleIndex: 0,
    });
  });

  it("should parse custom_id with special characters in scenario ID", () => {
    const result = parseCustomId("skill-abc-def-123_sample-5");

    expect(result).toEqual({
      scenarioId: "skill-abc-def-123",
      sampleIndex: 5,
    });
  });

  it("should parse custom_id with large sample index", () => {
    const result = parseCustomId("scenario_sample-999");

    expect(result).toEqual({
      scenarioId: "scenario",
      sampleIndex: 999,
    });
  });

  it("should return null for missing sample part", () => {
    const result = parseCustomId("no-sample-part");

    expect(result).toBeNull();
  });

  it("should return null for empty scenario ID", () => {
    const result = parseCustomId("_sample-0");

    expect(result).toBeNull();
  });

  it("should return null for non-numeric sample index", () => {
    const result = parseCustomId("scenario_sample-abc");

    expect(result).toBeNull();
  });

  it("should return null for malformed custom_id", () => {
    const result = parseCustomId("invalid-format");

    expect(result).toBeNull();
  });

  it("should return null for empty string", () => {
    const result = parseCustomId("");

    expect(result).toBeNull();
  });
});
