/**
 * Centralized type exports.
 */

// Plugin types
export type {
  PluginErrorType,
  McpServerStatus,
  TimingBreakdown,
  PluginLoadDiagnostics,
  PluginLoadResult,
  PluginManifest,
  ResolvedPaths,
  PreflightError,
  PreflightWarning,
  PreflightResult,
} from "./plugin.js";

// Component types
export type {
  SemanticIntent,
  SemanticVariation,
  SkillComponent,
  AgentExample,
  AgentComponent,
  CommandComponent,
  HookType,
  HookEventType,
  HookExpectedBehavior,
  HookAction,
  HookEventHandler,
  HookComponent,
} from "./components.js";

// MCP types
export type {
  McpServerType,
  McpToolDefinition,
  McpServerConfig,
  McpConfigFile,
  McpComponent,
} from "./mcp.js";

// Scenario types
export type {
  ScenarioType,
  ComponentType,
  SetupMessage,
  TestScenario,
  DiversityConfig,
  ScenarioDistribution,
  BaseScenario,
  ScenarioVariation,
} from "./scenario.js";

// Transcript types
export type {
  ToolCapture,
  HookResponseCapture,
  TranscriptMetadata,
  UserEvent,
  ToolCall,
  AssistantEvent,
  ToolResultEvent,
  TranscriptErrorType,
  TranscriptErrorEvent,
  TranscriptEvent,
  Transcript,
  ExecutionResult,
} from "./transcript.js";

// Evaluation types
export type {
  ProgrammaticDetection,
  TriggeredComponent,
  ConflictAnalysis,
  Citation,
  HighlightWithCitation,
  JudgeResponse,
  MultiSampleResult,
  DetectionSource,
  EvaluationResult,
  ComponentMetrics,
  MultiSampleStats,
  SemanticStats,
  RepetitionStats,
  EvalMetrics,
  MetaJudgmentResult,
} from "./evaluation.js";

// Evaluation Zod schemas (runtime validation)
export {
  CitationSchema,
  HighlightWithCitationSchema,
  JudgeResponseSchema,
} from "./evaluation.js";

// Config types
export type {
  PluginConfig,
  MarketplaceConfig,
  ScopeConfig,
  ReasoningEffort,
  SessionStrategy,
  GenerationConfig,
  ExecutionConfig,
  DetectionMode,
  AggregateMethod,
  EvaluationConfig,
  OutputFormat,
  OutputConfig,
  ResumeConfig,
  FastModeConfig,
  McpServersConfig,
  ConflictDetectionConfig,
  TimeoutsConfig,
  RetryTuningConfig,
  TokenEstimatesConfig,
  LimitsConfig,
  BatchingConfig,
  TuningConfig,
  EvalConfig,
} from "./config.js";

// State types
export type {
  PipelineStage,
  SkillTriggerInfo,
  AgentTriggerInfo,
  CommandTriggerInfo,
  HookTriggerInfo,
  McpTriggerInfo,
  AnalysisOutput,
  PipelineState,
} from "./state.js";

// Progress types
export type { ProgressCallbacks } from "./progress.js";

// Cost types
export type {
  ModelPricing,
  TokenEstimate,
  PipelineCostEstimate,
} from "./cost.js";
