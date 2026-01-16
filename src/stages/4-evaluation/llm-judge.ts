/**
 * LLM Judge - Quality assessment using structured output.
 *
 * Secondary evaluation method that assesses response quality,
 * validates edge cases, and confirms negative scenarios.
 *
 * Uses Anthropic's beta structured output API for guaranteed JSON parsing.
 */

import { DEFAULT_TUNING } from "../../config/defaults.js";
import {
  JudgeResponseSchema,
  type Citation,
  type EvaluationConfig,
  type HighlightWithCitation,
  type JudgeResponse,
  type ProgrammaticDetection,
  type TestScenario,
  type Transcript,
  type TranscriptEvent,
} from "../../types/index.js";
import { withRetry } from "../../utils/retry.js";
import { resolveModelId } from "../2-generation/cost-estimator.js";

import type Anthropic from "@anthropic-ai/sdk";

/**
 * Judge response schema for structured output.
 *
 * Using structured output ensures guaranteed JSON parsing.
 * The schema enforces the exact structure we expect.
 */
export const JUDGE_RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    quality_score: {
      type: "number" as const,
      description: "Overall quality of the response (1-10)",
    },
    response_relevance: {
      type: "number" as const,
      description:
        "How relevant the response was to the component purpose (1-10)",
    },
    trigger_accuracy: {
      type: "string" as const,
      enum: ["correct", "incorrect", "partial"] as const,
      description: "Whether the correct component triggered",
    },
    issues: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "List of issues or concerns found",
    },
    highlights: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          description: { type: "string" as const },
          message_id: { type: "string" as const },
          quoted_text: { type: "string" as const },
          position_start: { type: "number" as const },
          position_end: { type: "number" as const },
        },
        required: ["description", "message_id", "quoted_text"] as const,
      },
      description: "Notable quotes with citation grounding to message IDs",
    },
    summary: {
      type: "string" as const,
      description: "Brief summary of the evaluation",
    },
  },
  required: [
    "quality_score",
    "response_relevance",
    "trigger_accuracy",
    "issues",
    "summary",
  ] as const,
};

/**
 * Cacheable system instructions for LLM judge evaluation.
 *
 * These instructions are reused across all scenario evaluations and benefit
 * from Anthropic's prompt caching (90% cost reduction after first call).
 */
export const JUDGE_SYSTEM_PROMPT = `You are an evaluator for Claude Code plugin test executions.

Evaluate each test execution based on:
1. quality_score (1-10): How well did the component respond to the user's request?
2. response_relevance (1-10): Did the response align with the component's stated purpose?
3. trigger_accuracy: Was the triggering behavior correct given the scenario type?
   - "correct": Component triggered when expected, or didn't trigger when not expected
   - "incorrect": Component triggered when it shouldn't, or didn't trigger when it should
   - "partial": Component triggered but response was incomplete or had issues
4. issues: List any problems, errors, or unexpected behaviors
5. highlights: Notable quotes with citation grounding to message IDs
6. summary: Brief overall assessment

For negative scenarios (expected_trigger: false):
- "correct" means the component did NOT trigger (which is desired)
- "incorrect" means the component DID trigger (false positive)

For positive scenarios (expected_trigger: true):
- "correct" means the component triggered and responded appropriately
- "incorrect" means the component did NOT trigger (false negative)
- "partial" means it triggered but had issues`;

/**
 * User prompt template for judge evaluation (variable data only).
 */
const JUDGE_USER_PROMPT_TEMPLATE = `Evaluate this Claude Code plugin test execution:

PLUGIN: {{plugin_name}}
COMPONENT BEING TESTED: {{expected_component}} ({{component_type}})
SCENARIO TYPE: {{scenario_type}}
EXPECTED TO TRIGGER: {{expected_trigger}}
PROGRAMMATIC DETECTION: {{programmatic_result}}

TRANSCRIPT (with message IDs for citation):
{{formatted_transcript}}

COMPONENT DETAILS:
{{component_ref}}

{{citation_instruction}}`;

/**
 * Format transcript events with message IDs for citation grounding.
 *
 * Each message includes its ID so the judge can cite specific messages
 * in highlights.
 *
 * @param transcript - Execution transcript
 * @param maxContentLength - Maximum content length per message
 * @returns Formatted transcript string
 */
export function formatTranscriptWithIds(
  transcript: Transcript,
  maxContentLength = DEFAULT_TUNING.limits.transcript_content_length,
): string {
  return transcript.events
    .map((event) => formatEvent(event, maxContentLength))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Format a single transcript event.
 *
 * @param event - Transcript event
 * @param maxContentLength - Maximum content length
 * @returns Formatted event string
 */
function formatEvent(event: TranscriptEvent, maxContentLength: number): string {
  switch (event.type) {
    case "user": {
      const content = event.edit.message.content;
      const truncated =
        content.length > maxContentLength
          ? `${content.slice(0, maxContentLength)}...`
          : content;
      return `[${event.id}] USER: ${truncated}`;
    }

    case "assistant": {
      const content = event.edit.message.content;
      const truncated =
        content.length > maxContentLength
          ? `${content.slice(0, maxContentLength)}...`
          : content;

      const toolCalls = event.edit.message.tool_calls ?? [];
      const toolInfo =
        toolCalls.length > 0
          ? `\n  [Tools: ${toolCalls.map((tc) => tc.name).join(", ")}]`
          : "";

      return `[${event.id}] ASSISTANT: ${truncated}${toolInfo}`;
    }

    case "tool_result": {
      const resultStr =
        typeof event.result === "string"
          ? event.result
          : JSON.stringify(event.result);
      const truncated =
        resultStr.length > maxContentLength
          ? `${resultStr.slice(0, maxContentLength)}...`
          : resultStr;
      return `[${event.id}] TOOL_RESULT: ${truncated}`;
    }
  }
}

/**
 * Build the user prompt for judge evaluation.
 *
 * Returns only the variable data (scenario details, transcript) - the static
 * instructions are in JUDGE_SYSTEM_PROMPT for caching.
 *
 * @param scenario - Test scenario
 * @param transcript - Execution transcript
 * @param programmaticResult - Programmatic detection results
 * @param config - Evaluation configuration
 * @returns User prompt with variable data
 */
export function buildJudgePrompt(
  scenario: TestScenario,
  transcript: Transcript,
  programmaticResult: ProgrammaticDetection[],
  config: EvaluationConfig,
): string {
  const formattedTranscript = formatTranscriptWithIds(transcript);

  const programmaticDisplay =
    programmaticResult.length > 0
      ? programmaticResult
          .map((d) => `${d.component_type}:${d.component_name}`)
          .join(", ")
      : "No components detected";

  const citationInstruction = config.include_citations
    ? "For each highlight, include message_id and quoted_text for citation grounding."
    : "Include notable quotes demonstrating good or bad behavior.";

  return JUDGE_USER_PROMPT_TEMPLATE.replace(
    "{{plugin_name}}",
    transcript.metadata.plugin_name,
  )
    .replace("{{expected_component}}", scenario.expected_component)
    .replace("{{component_type}}", scenario.component_type)
    .replace("{{scenario_type}}", scenario.scenario_type)
    .replace("{{expected_trigger}}", String(scenario.expected_trigger))
    .replace("{{programmatic_result}}", programmaticDisplay)
    .replace("{{formatted_transcript}}", formattedTranscript)
    .replace("{{component_ref}}", scenario.component_ref)
    .replace("{{citation_instruction}}", citationInstruction);
}

/**
 * Parse judge response from structured output.
 *
 * Uses Zod validation after JSON parsing for additional runtime type safety.
 *
 * @param text - JSON text from structured output
 * @returns Parsed and validated judge response
 * @throws {Error} If JSON parsing fails or validation fails
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
      tool_call_id?: string;
    }[];
    summary: string;
  };

  // Transform highlights from API format to internal format
  const highlights = parsed.highlights?.map((h): HighlightWithCitation => {
    const citation: Citation = {
      message_id: h.message_id,
      quoted_text: h.quoted_text,
      position: [h.position_start ?? 0, h.position_end ?? 0] as [
        number,
        number,
      ],
    };
    if (h.tool_call_id !== undefined) {
      citation.tool_call_id = h.tool_call_id;
    }
    return { description: h.description, citation };
  });

  // Build result object (without highlights initially)
  const result: JudgeResponse = {
    quality_score: parsed.quality_score,
    response_relevance: parsed.response_relevance,
    trigger_accuracy: parsed.trigger_accuracy,
    issues: parsed.issues,
    summary: parsed.summary,
  };

  // Only add highlights if present (exactOptionalPropertyTypes requires this pattern)
  if (highlights !== undefined) {
    result.highlights = highlights;
  }

  // Validate with Zod schema for runtime type safety
  const validated = JudgeResponseSchema.parse(result);

  // Return with proper handling for exactOptionalPropertyTypes
  // Zod may return undefined for optional fields, but our interface expects absence
  const response: JudgeResponse = {
    quality_score: validated.quality_score,
    response_relevance: validated.response_relevance,
    trigger_accuracy: validated.trigger_accuracy,
    issues: validated.issues,
    summary: validated.summary,
  };

  // Transform highlights to remove undefined values from optional fields
  if (validated.highlights !== undefined) {
    response.highlights = validated.highlights.map(
      (h): HighlightWithCitation => {
        const citation: Citation = {
          message_id: h.citation.message_id,
          quoted_text: h.citation.quoted_text,
          position: h.citation.position,
        };
        if (h.citation.tool_call_id !== undefined) {
          citation.tool_call_id = h.citation.tool_call_id;
        }
        return { description: h.description, citation };
      },
    );
  }

  return response;
}

/**
 * Evaluate a scenario using the LLM judge.
 *
 * Uses Anthropic's beta structured output API for guaranteed JSON parsing,
 * with prompt caching for the system instructions to reduce input token costs.
 *
 * @param client - Anthropic client
 * @param scenario - Test scenario
 * @param transcript - Execution transcript
 * @param programmaticResult - Programmatic detection results
 * @param config - Evaluation configuration
 * @returns Judge response
 *
 * @example
 * ```typescript
 * const response = await evaluateWithLLMJudge(
 *   client,
 *   scenario,
 *   transcript,
 *   detections,
 *   config
 * );
 *
 * console.log(`Quality: ${response.quality_score}/10`);
 * ```
 */
export async function evaluateWithLLMJudge(
  client: Anthropic,
  scenario: TestScenario,
  transcript: Transcript,
  programmaticResult: ProgrammaticDetection[],
  config: EvaluationConfig,
): Promise<JudgeResponse> {
  const userPrompt = buildJudgePrompt(
    scenario,
    transcript,
    programmaticResult,
    config,
  );

  const response = await withRetry(async () => {
    // Use Anthropic's beta structured output API with prompt caching
    const result = await client.beta.messages.create(
      {
        model: resolveModelId(config.model),
        max_tokens: config.max_tokens,
        temperature: config.temperature,
        system: [
          {
            type: "text",
            text: JUDGE_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
        betas: ["structured-outputs-2025-11-13"],
        // Anthropic uses output_format with schema directly (not nested json_schema)
        output_format: {
          type: "json_schema",
          schema: JUDGE_RESPONSE_SCHEMA,
        },
      },
      { timeout: config.api_timeout_ms },
    );

    // Extract text content from structured output response
    const textBlock = result.content.find((block) => block.type === "text");
    if (textBlock?.type !== "text") {
      throw new Error("No text block in structured output response");
    }

    return textBlock.text;
  });

  try {
    return parseJudgeResponse(response);
  } catch (err) {
    throw new Error(`Failed to parse structured output: ${String(err)}`);
  }
}

/**
 * Evaluate with fallback to regular JSON parsing.
 *
 * If structured output isn't available, falls back to requesting
 * JSON output and parsing it manually.
 *
 * @param client - Anthropic client
 * @param scenario - Test scenario
 * @param transcript - Execution transcript
 * @param programmaticResult - Programmatic detection results
 * @param config - Evaluation configuration
 * @returns Judge response
 */
export async function evaluateWithFallback(
  client: Anthropic,
  scenario: TestScenario,
  transcript: Transcript,
  programmaticResult: ProgrammaticDetection[],
  config: EvaluationConfig,
): Promise<JudgeResponse> {
  try {
    // Try structured output first
    return await evaluateWithLLMJudge(
      client,
      scenario,
      transcript,
      programmaticResult,
      config,
    );
  } catch {
    // Fallback to regular JSON parsing
    return evaluateWithJsonFallback(
      client,
      scenario,
      transcript,
      programmaticResult,
      config,
    );
  }
}

/**
 * Cacheable JSON schema instructions for fallback evaluation.
 *
 * Separate from JUDGE_SYSTEM_PROMPT because this includes the output schema.
 */
const JUDGE_FALLBACK_SYSTEM_PROMPT = `${JUDGE_SYSTEM_PROMPT}

Respond with ONLY a JSON object matching this schema:
{
  "quality_score": number (1-10),
  "response_relevance": number (1-10),
  "trigger_accuracy": "correct" | "incorrect" | "partial",
  "issues": string[],
  "highlights": [{ "description": string, "message_id": string, "quoted_text": string }],
  "summary": string
}

No markdown, no explanation - just the JSON.`;

/**
 * Evaluate using regular JSON output (fallback method).
 *
 * Uses prompt caching for the system instructions to reduce input token costs.
 *
 * @param client - Anthropic client
 * @param scenario - Test scenario
 * @param transcript - Execution transcript
 * @param programmaticResult - Programmatic detection results
 * @param config - Evaluation configuration
 * @returns Judge response
 */
async function evaluateWithJsonFallback(
  client: Anthropic,
  scenario: TestScenario,
  transcript: Transcript,
  programmaticResult: ProgrammaticDetection[],
  config: EvaluationConfig,
): Promise<JudgeResponse> {
  const userPrompt = buildJudgePrompt(
    scenario,
    transcript,
    programmaticResult,
    config,
  );

  const response = await withRetry(async () => {
    const result = await client.messages.create(
      {
        model: resolveModelId(config.model),
        max_tokens: config.max_tokens,
        temperature: config.temperature,
        system: [
          {
            type: "text",
            text: JUDGE_FALLBACK_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userPrompt }],
      },
      { timeout: config.api_timeout_ms },
    );

    const textBlock = result.content.find((block) => block.type === "text");
    if (textBlock?.type !== "text") {
      throw new Error("No text content in response");
    }
    return textBlock.text;
  });

  // Extract JSON from response (handle markdown code blocks)
  let jsonText = response.trim();
  const jsonMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(jsonText);
  if (jsonMatch?.[1]) {
    jsonText = jsonMatch[1].trim();
  }

  try {
    return parseJudgeResponse(jsonText);
  } catch (err) {
    // Return a default error response if parsing fails
    return {
      quality_score: 1,
      response_relevance: 1,
      trigger_accuracy: "incorrect",
      issues: [`Failed to parse judge response: ${String(err)}`, response],
      summary: "Evaluation failed due to parsing error",
    };
  }
}

/**
 * Create default judge response for error cases.
 *
 * @param error - Error message
 * @returns Default judge response
 */
export function createErrorJudgeResponse(error: string): JudgeResponse {
  return {
    quality_score: 0,
    response_relevance: 0,
    trigger_accuracy: "incorrect",
    issues: [error],
    summary: `Evaluation failed: ${error}`,
  };
}
