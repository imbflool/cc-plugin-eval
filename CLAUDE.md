# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cc-plugin-eval is a 4-stage evaluation framework for testing Claude Code plugin component triggering. It evaluates whether skills, agents, commands, hooks, and MCP servers correctly activate when expected.

**Requirements**: Node.js >= 20.0.0, Anthropic API key (in `.env` as `ANTHROPIC_API_KEY`)

## Commands

```bash
# Build & Dev
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode

# Lint & Type Check
npm run lint           # ESLint
npm run lint:fix       # Auto-fix
npm run typecheck      # tsc --noEmit

# Test
npm run test           # All tests (Vitest)
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage
npm run test:ui        # Visual test UI (opens browser)

# Single test file
npx vitest run tests/unit/stages/1-analysis/skill-analyzer.test.ts

# Tests matching pattern
npx vitest run -t "SkillAnalyzer"

# E2E tests (requires API key, costs money)
RUN_E2E_TESTS=true npm test -- tests/e2e/
RUN_E2E_TESTS=true E2E_MAX_COST_USD=2.00 npm test -- tests/e2e/
```

**Test behavior**: Parallel execution, randomized order, 30s timeout. CI retries failed tests twice.

### Additional Linters

```bash
npx prettier --check "src/**/*.ts" "*.json" "*.md"
markdownlint "*.md"
uvx yamllint -c .yamllint.yml config.yaml .yamllint.yml
actionlint .github/workflows/*.yml
```

## CLI Usage

```bash
cc-plugin-eval run -p ./plugin           # Full pipeline
cc-plugin-eval analyze -p ./plugin       # Stage 1 only
cc-plugin-eval generate -p ./plugin      # Stages 1-2
cc-plugin-eval execute -p ./plugin       # Stages 1-3
cc-plugin-eval run -p ./plugin --dry-run # Cost estimation only
cc-plugin-eval resume -r <run-id>        # Resume interrupted run
cc-plugin-eval run -p ./plugin --fast    # Re-run failed scenarios only
```

## Architecture

### 4-Stage Pipeline

| Stage             | Purpose                                                                             | Output            |
| ----------------- | ----------------------------------------------------------------------------------- | ----------------- |
| **1. Analysis**   | Parse plugin structure, extract triggers                                            | `analysis.json`   |
| **2. Generation** | Create test scenarios (LLM for skills/agents, deterministic for commands/hooks/MCP) | `scenarios.json`  |
| **3. Execution**  | Run scenarios via Claude Agent SDK with tool capture                                | `transcripts/`    |
| **4. Evaluation** | Programmatic detection first, LLM judge fallback, metrics calculation               | `evaluation.json` |

### Key Entry Points

| Component         | File                                               | Main Export                   |
| ----------------- | -------------------------------------------------- | ----------------------------- |
| CLI               | `src/index.ts`                                     | Commander `program`           |
| Stage 1           | `src/stages/1-analysis/index.ts`                   | `runAnalysis()`               |
| Stage 2           | `src/stages/2-generation/index.ts`                 | `runGeneration()`             |
| Stage 3           | `src/stages/3-execution/index.ts`                  | `runExecution()`              |
| Stage 4           | `src/stages/4-evaluation/index.ts`                 | `runEvaluation()`             |
| Detection         | `src/stages/4-evaluation/programmatic-detector.ts` | `detectAllComponents()`       |
| Conflict Tracking | `src/stages/4-evaluation/conflict-tracker.ts`      | `calculateConflictSeverity()` |
| Metrics           | `src/stages/4-evaluation/metrics.ts`               | `calculateEvalMetrics()`      |
| State             | `src/state/state-manager.ts`                       | `loadState()`, `saveState()`  |

## Code Navigation

This project has MCP tools configured for efficient code exploration and editing.

### Tool Selection

| Task                      | Tool                       | Example                                  |
| ------------------------- | -------------------------- | ---------------------------------------- |
| Find a function/interface | `find_symbol`              | "Find the `runEvaluation` function"      |
| Find all callers          | `find_referencing_symbols` | "What calls `detectFromCaptures`?"       |
| Understand file structure | `get_symbols_overview`     | "Show symbols in `src/types/index.ts`"   |
| Semantic code search      | `warpgrep_codebase_search` | "How does conflict detection work?"      |
| Exact pattern search      | `rg "pattern"`             | `rg "ExecutionResult"`                   |
| Edit code                 | `edit_file`                | Partial snippets, lazy patterns OK       |
| Rename across codebase    | `rename_symbol`            | Refactor `TestScenario` → `EvalScenario` |

### Navigation Patterns

**Understanding a stage**: Use `get_symbols_overview` on the stage's `index.ts`, then `find_referencing_symbols` on the main export to see how it integrates with the pipeline.

**Refactoring types**: Use `find_referencing_symbols` on a type from `src/types/` to find all usages before making changes.

**Tracing detection logic**: The detection flow is `detectAllComponents` → `detectFromCaptures` / `detectFromTranscript` → type-specific detectors. Agent detection uses SubagentStart/SubagentStop hooks. Use `find_symbol` to navigate this chain.

**Adding a new component type**: Follow the type through all four stages using `find_referencing_symbols` on similar component types (e.g., trace how `hooks` is handled to understand where to add `mcp_servers`).

### Serena MCP Best Practices

**Symbol-First Philosophy**: Never read entire source files when you can use symbolic tools. Use `get_symbols_overview` to understand file structure, then `find_symbol` with `include_body=true` only for the specific symbols you need.

**Name Path Patterns**: Serena uses hierarchical name paths like `ClassName/methodName`. Examples:

- `runEvaluation` - Matches any symbol named `runEvaluation`
- `ProgrammaticDetector/detectFromCaptures` - Matches method in class
- `/ClassName/method` - Absolute path (exact match required)
- Use `substring_matching=true` for partial matches: `detect` finds `detectFromCaptures`, `detectAllComponents`

**Key Parameters**:

| Parameter                       | Use Case                                               |
| ------------------------------- | ------------------------------------------------------ |
| `depth=1`                       | Get class methods: `find_symbol("ClassName", depth=1)` |
| `include_body=true`             | Get actual code (use sparingly)                        |
| `relative_path`                 | Restrict search scope for speed                        |
| `restrict_search_to_code_files` | In `search_for_pattern`, limits to TypeScript files    |

**Non-Code File Search**: Use `search_for_pattern` (not `find_symbol`) for YAML, JSON, markdown:

```text
search_for_pattern("pattern", paths_include_glob="*.json")
```

**Serena Memories**: This project has pre-built memories in `.serena/memories/`. Read relevant ones before major changes:

| Memory                   | When to Read                                          |
| ------------------------ | ----------------------------------------------------- |
| `architecture_decisions` | Before changing detection logic or pipeline structure |
| `testing_patterns`       | Before writing tests                                  |
| `code_style`             | Before writing new code                               |

**Thinking Tools**: Use Serena's thinking tools at key points:

- `think_about_collected_information` - After searching, before acting
- `think_about_task_adherence` - Before making edits
- `think_about_whether_you_are_done` - Before completing a task

## Directory Structure

```text
src/
├── index.ts              # CLI entry point (env.ts MUST be first import)
├── env.ts                # Environment setup (dotenv loading)
├── config/               # Configuration loading with Zod validation
│   ├── defaults.ts       # Default configuration values
│   ├── loader.ts         # YAML/JSON config loading
│   ├── pricing.ts        # Model pricing for cost estimation
│   └── schema.ts         # Zod validation schemas
├── stages/
│   ├── 1-analysis/       # Plugin parsing, trigger extraction
│   ├── 2-generation/     # Scenario generation (LLM + deterministic)
│   ├── 3-execution/      # Agent SDK integration, tool capture
│   └── 4-evaluation/     # Programmatic detection, LLM judge, metrics
├── state/                # Resume capability, checkpointing
├── types/                # TypeScript interfaces
└── utils/                # Retry, concurrency, logging utilities

tests/
├── unit/                 # Unit tests (mirror src/ structure)
├── integration/          # Integration tests for full stages
├── e2e/                  # End-to-end tests (real SDK calls)
├── mocks/                # Mock implementations for testing
└── fixtures/             # Test data and mock plugins
```

## Adding a New Component Type

When adding support for a new plugin component type (e.g., a new kind of trigger):

1. Define types in `src/types/`
2. Create analyzer in `src/stages/1-analysis/`
3. Create scenario generator in `src/stages/2-generation/`
4. Extend detection in `src/stages/4-evaluation/programmatic-detector.ts`
5. Update `AnalysisOutput` in `src/types/state.ts`
6. Add to pipeline in `src/stages/{1,2,4}-*/index.ts`
7. Add state migration in `src/state/state-manager.ts` (provide defaults for legacy state)
8. Add tests

### State Migration

When adding new component types, update `migrateState()` in `src/state/state-manager.ts` to provide defaults (e.g., `hooks: legacyComponents.hooks ?? []`) so existing state files remain compatible.

### Resume Handlers

The CLI uses a handler map in `src/index.ts` for stage-based resume. State files are stored at `results/<plugin-name>/<run-id>/state.json`.

## Component-Specific Notes

### Hooks

Enable: `scope.hooks: true`

Hooks use the `EventType::Matcher` format (e.g., "PreToolUse::Write|Edit"). Detection happens via `SDKHookResponseMessage` events with 100% confidence. Scenarios are generated deterministically via tool-to-prompt mapping.

**Limitation**: Session lifecycle hooks (SessionStart, SessionEnd) fire once per session.

### MCP Servers

Enable: `scope.mcp_servers: true`

Tools are detected via the pattern `mcp__<server>__<tool>`. Scenarios are generated deterministically (zero LLM cost). The SDK auto-connects to servers defined in `.mcp.json`.

**Limitation**: Tool schemas are not validated.

## Implementation Patterns

### Custom Error Classes

Use cause chains for error context. See `src/config/loader.ts:ConfigLoadError` for the pattern.

### Type Guards

Use type guards for tool detection in `src/stages/4-evaluation/programmatic-detector.ts`. Examples include `isSkillInput()` and `isTaskInput()`.

### Parallel Execution with Concurrency Control

Use `src/utils/concurrency.ts` for controlled parallel execution with progress callbacks. The utility handles error aggregation and respects concurrency limits.

### Retry Logic

Use `src/utils/retry.ts` for API calls. It implements exponential backoff with configurable max attempts and handles transient failures gracefully.

### Configuration Validation

All configuration uses Zod schemas in `src/config/`. The loader validates at runtime and provides clear error messages for invalid configuration.

## Testing Patterns

### Unit Tests

Unit tests live in `tests/unit/` and mirror the `src/` structure. They use Vitest with `vi.mock()` for dependencies.

### Integration Tests

Integration tests in `tests/integration/` test full stage execution with real fixtures but mocked LLM calls.

### E2E Tests

E2E tests in `tests/e2e/` make real API calls and cost money. They are skipped by default and enabled via `RUN_E2E_TESTS=true`. Budget limits are enforced via `E2E_MAX_COST_USD`.

### Fixtures

Test fixtures live in `tests/fixtures/`. Sample transcripts are in `tests/fixtures/sample-transcripts/`. Mock plugins are in `tests/fixtures/valid-plugin/`.

## CI/CD

The project uses GitHub Actions for CI. Key workflows:

| Workflow                    | Purpose                                             |
| --------------------------- | --------------------------------------------------- |
| `ci.yml`                    | Build, lint, typecheck, test on PR and push         |
| `ci-failure-analysis.yml`   | AI analysis of CI failures                          |
| `claude-pr-review.yml`      | AI-powered code review on PRs                       |
| `claude-issue-analysis.yml` | AI-powered issue analysis                           |
| `claude.yml`                | Claude Code interactive workflow                    |
| `semantic-labeler.yml`      | Auto-label issues and PRs based on content          |
| `markdownlint.yml`          | Markdown linting                                    |
| `yaml-lint.yml`             | YAML linting                                        |
| `validate-workflows.yml`    | Validate GitHub Actions workflows with `actionlint` |
| `links.yml`                 | Check for broken links in documentation             |
| `sync-labels.yml`           | Sync repository labels from `labels.yml`            |
| `stale.yml`                 | Mark and close stale issues/PRs                     |
| `greet.yml`                 | Welcome new contributors                            |

CI runs tests in parallel with randomized order. Failed tests are retried twice before marking as failed.

## GitHub Issue Management

### Issue Blocking Relationships

Use GraphQL mutations to set up issue dependencies (blocked by / blocks relationships).

**Get issue node IDs:**

```bash
gh issue list --state open --json number,id | jq -r '.[] | "\(.number)\t\(.id)"'
```

**Add a blocking relationship** (issueId is blocked by blockingIssueId):

```bash
gh api graphql -f query='
mutation {
  addBlockedBy(input: {
    issueId: "I_kwDO...",
    blockingIssueId: "I_kwDO..."
  }) {
    issue { number title }
    blockingIssue { number title }
  }
}'
```

**Remove a blocking relationship:**

```bash
gh api graphql -f query='
mutation {
  removeBlockedBy(input: {
    issueId: "I_kwDO...",
    blockingIssueId: "I_kwDO..."
  }) {
    issue { number title }
    blockingIssue { number title }
  }
}'
```

**Example:** To make #205 block #207 (meaning #207 is blocked by #205):

- `issueId` = #207's node ID (the blocked issue)
- `blockingIssueId` = #205's node ID (the blocking issue)
