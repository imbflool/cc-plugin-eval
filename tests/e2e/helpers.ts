/**
 * E2E Test Helpers
 *
 * Configuration factories and utilities for end-to-end integration tests
 * that run the full pipeline with real Anthropic SDK calls.
 *
 * @module tests/e2e/helpers
 */

import path from "node:path";

import type {
  EvalConfig,
  ExecutionConfig,
  EvaluationConfig,
  GenerationConfig,
  OutputConfig,
  PluginConfig,
  ScopeConfig,
} from "../../src/types/config.js";

// =============================================================================
// Constants
// =============================================================================

/** Default test plugin path */
export const E2E_PLUGIN_PATH = path.resolve(
  process.cwd(),
  "tests/fixtures/valid-plugin",
);

/** Default E2E test budget in USD (per test, using Sonnet models) */
export const E2E_DEFAULT_BUDGET_USD = 0.5;

/** Maximum cost per E2E run from env or default */
export const E2E_MAX_COST_USD = process.env.E2E_MAX_COST_USD
  ? Number.parseFloat(process.env.E2E_MAX_COST_USD)
  : 5.0;

/** Check if E2E tests should run */
export function shouldRunE2E(): boolean {
  return process.env.RUN_E2E_TESTS === "true";
}

// =============================================================================
// Configuration Factories
// =============================================================================

/**
 * Create minimal E2E scope configuration.
 *
 * @param overrides - Partial scope to override defaults
 * @returns Scope configuration
 */
export function createE2EScope(
  overrides: Partial<ScopeConfig> = {},
): ScopeConfig {
  return {
    skills: false,
    agents: false,
    commands: false,
    hooks: false,
    mcp_servers: false, // MCP connections slow down tests significantly
    ...overrides,
  };
}

/**
 * Create E2E generation configuration matching pipeline defaults.
 *
 * @param overrides - Partial config to override defaults
 * @returns Generation configuration
 */
export function createE2EGenerationConfig(
  overrides: Partial<GenerationConfig> = {},
): GenerationConfig {
  return {
    model: "claude-sonnet-4-5-20250929", // Match pipeline default
    scenarios_per_component: 1,
    diversity: 0, // Only base scenarios, no variations
    max_tokens: 512,
    reasoning_effort: "none",
    semantic_variations: false,
    ...overrides,
  };
}

/**
 * Create E2E execution configuration matching pipeline defaults.
 *
 * @param overrides - Partial config to override defaults
 * @returns Execution configuration
 */
export function createE2EExecutionConfig(
  overrides: Partial<ExecutionConfig> = {},
): ExecutionConfig {
  return {
    model: "claude-sonnet-4-20250514", // Match pipeline default
    max_turns: 2,
    timeout_ms: 60000, // 60 second timeout per scenario
    max_budget_usd: E2E_DEFAULT_BUDGET_USD,
    // E2E tests use batched sessions (production default) for performance.
    // Sessions are reset between scenarios via /clear commands to maintain isolation.
    // Set session_isolation: true for isolated testing if needed.
    session_isolation: false,
    permission_bypass: true,
    disallowed_tools: ["Write", "Edit", "Bash"], // Block file modifications
    num_reps: 1,
    additional_plugins: [],
    requests_per_second: 2, // Conservative rate limit (2x default for faster E2E)
    ...overrides,
  };
}

/**
 * Create E2E evaluation configuration matching pipeline defaults.
 *
 * @param overrides - Partial config to override defaults
 * @returns Evaluation configuration
 */
export function createE2EEvaluationConfig(
  overrides: Partial<EvaluationConfig> = {},
): EvaluationConfig {
  return {
    model: "claude-sonnet-4-5-20250929", // Match pipeline default
    max_tokens: 256,
    detection_mode: "programmatic_first", // Use programmatic detection primarily
    reasoning_effort: "none",
    num_samples: 1,
    aggregate_method: "average",
    include_citations: false,
    ...overrides,
  };
}

/**
 * Create E2E output configuration.
 *
 * @param overrides - Partial config to override defaults
 * @returns Output configuration
 */
export function createE2EOutputConfig(
  overrides: Partial<OutputConfig> = {},
): OutputConfig {
  return {
    format: "json",
    include_cli_summary: false,
    junit_test_suite_name: "e2e-tests",
    sanitize_transcripts: false,
    sanitize_logs: false,
    ...overrides,
  };
}

/**
 * Create E2E plugin configuration.
 *
 * @param pluginPath - Path to plugin directory
 * @returns Plugin configuration
 */
export function createE2EPluginConfig(
  pluginPath: string = E2E_PLUGIN_PATH,
): PluginConfig {
  return {
    path: pluginPath,
  };
}

/**
 * Options for creating E2E configuration.
 */
export interface E2EConfigOptions {
  /** Plugin path (defaults to test fixture) */
  pluginPath?: string;
  /** Scope overrides */
  scope?: Partial<ScopeConfig>;
  /** Generation config overrides */
  generation?: Partial<GenerationConfig>;
  /** Execution config overrides */
  execution?: Partial<ExecutionConfig>;
  /** Evaluation config overrides */
  evaluation?: Partial<EvaluationConfig>;
  /** Output config overrides */
  output?: Partial<OutputConfig>;
  /** Maximum budget in USD */
  maxBudgetUsd?: number;
}

/**
 * Create complete E2E evaluation configuration.
 *
 * Uses the same models as the pipeline defaults to ensure E2E tests
 * accurately reflect production behavior. Cost is minimized through:
 * - Minimal turns and scenarios per component
 * - Programmatic detection first (avoids extra LLM calls)
 * - Rate limited API calls
 *
 * @param options - Configuration options
 * @returns Complete evaluation configuration
 *
 * @example
 * ```typescript
 * const config = createE2EConfig({
 *   scope: { skills: true },
 *   execution: { max_turns: 3 },
 * });
 * ```
 */
export function createE2EConfig(options: E2EConfigOptions = {}): EvalConfig {
  const {
    pluginPath,
    scope = {},
    generation = {},
    execution = {},
    evaluation = {},
    output = {},
    maxBudgetUsd = E2E_DEFAULT_BUDGET_USD,
  } = options;

  return {
    plugin: createE2EPluginConfig(pluginPath),
    scope: createE2EScope(scope),
    generation: createE2EGenerationConfig(generation),
    execution: createE2EExecutionConfig({
      max_budget_usd: maxBudgetUsd,
      ...execution,
    }),
    evaluation: createE2EEvaluationConfig(evaluation),
    output: createE2EOutputConfig(output),
    dry_run: false,
    estimate_costs: false,
    batch_threshold: 100, // Never use batching for E2E
    force_synchronous: true,
    poll_interval_ms: 1000,
    rewind_file_changes: true,
    debug: false,
    verbose: false,
    max_concurrent: 3, // Parallel execution for faster E2E tests
  };
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validate E2E environment is properly configured.
 *
 * @throws Error if required environment variables are missing
 */
export function validateE2EEnvironment(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("E2E tests require ANTHROPIC_API_KEY environment variable");
  }
}

/**
 * Check if cost is within E2E budget.
 *
 * @param costUsd - Cost in USD
 * @returns True if within budget
 */
export function isWithinE2EBudget(costUsd: number): boolean {
  return costUsd <= E2E_MAX_COST_USD;
}

// =============================================================================
// Result Validation Helpers
// =============================================================================

/**
 * Metrics from E2E pipeline run.
 */
export interface E2EMetrics {
  totalCostUsd: number;
  totalDurationMs: number;
  scenarioCount: number;
  triggeredCount: number;
  errorCount: number;
  accuracy: number;
  triggerRate: number;
}

/**
 * Calculate metrics from evaluation results.
 *
 * @param results - Evaluation results array
 * @returns Calculated metrics
 */
export function calculateE2EMetrics(
  results: Array<{
    triggered: boolean;
    expected_trigger: boolean;
    cost_usd?: number;
    duration_ms?: number;
    errors?: unknown[];
  }>,
): E2EMetrics {
  const scenarioCount = results.length;
  const triggeredCount = results.filter((r) => r.triggered).length;
  const correctCount = results.filter(
    (r) => r.triggered === r.expected_trigger,
  ).length;
  const errorCount = results.filter((r) => (r.errors?.length ?? 0) > 0).length;
  const totalCostUsd = results.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const totalDurationMs = results.reduce(
    (sum, r) => sum + (r.duration_ms ?? 0),
    0,
  );

  return {
    totalCostUsd,
    totalDurationMs,
    scenarioCount,
    triggeredCount,
    errorCount,
    accuracy: scenarioCount > 0 ? correctCount / scenarioCount : 0,
    triggerRate: scenarioCount > 0 ? triggeredCount / scenarioCount : 0,
  };
}

/**
 * Assert E2E metrics are within acceptable ranges.
 *
 * @param metrics - E2E metrics to validate
 * @param options - Validation options
 */
export function assertE2EMetrics(
  metrics: E2EMetrics,
  options: {
    minAccuracy?: number;
    maxCostUsd?: number;
    maxErrorCount?: number;
  } = {},
): void {
  const {
    minAccuracy = 0.5,
    maxCostUsd = E2E_MAX_COST_USD,
    maxErrorCount = 0,
  } = options;

  if (metrics.accuracy < minAccuracy) {
    throw new Error(
      `E2E accuracy ${metrics.accuracy.toFixed(2)} below minimum ${minAccuracy}`,
    );
  }

  if (metrics.totalCostUsd > maxCostUsd) {
    throw new Error(
      `E2E cost $${metrics.totalCostUsd.toFixed(4)} exceeds budget $${maxCostUsd.toFixed(2)}`,
    );
  }

  if (metrics.errorCount > maxErrorCount) {
    throw new Error(
      `E2E errors ${metrics.errorCount} exceed maximum ${maxErrorCount}`,
    );
  }
}
