# cc-plugin-eval

[![CI](https://github.com/sjnims/cc-plugin-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/sjnims/cc-plugin-eval/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/sjnims/cc-plugin-eval/graph/badge.svg?token=qngSWBvOqn)](https://codecov.io/gh/sjnims/cc-plugin-eval)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)

A 4-stage evaluation framework for testing Claude Code plugin component triggering. Validates whether skills, agents, commands, hooks, and MCP servers correctly activate when expected.

## Why This Exists

Claude Code plugins contain multiple component types (skills, agents, commands) that trigger based on user prompts. Testing these triggers manually is time-consuming and error-prone. This framework automates the entire evaluation process:

- **Discovers** all components in your plugin
- **Generates** test scenarios (positive and negative cases)
- **Executes** scenarios against the Claude Agent SDK
- **Evaluates** whether the correct component triggered

## Features

| Feature                    | Description                                              |
| -------------------------- | -------------------------------------------------------- |
| **4-Stage Pipeline**       | Analysis → Generation → Execution → Evaluation           |
| **Multi-Component**        | Skills, agents, commands, hooks, and MCP servers         |
| **Programmatic Detection** | 100% confidence detection by parsing tool captures       |
| **Semantic Testing**       | Synonym and paraphrase variations to test robustness     |
| **Resume Capability**      | Checkpoint after each stage, resume interrupted runs     |
| **Cost Estimation**        | Token and USD estimates before execution                 |
| **Batch API Support**      | 50% cost savings on large runs via Anthropic Batches API |
| **Multiple Formats**       | JSON, YAML, JUnit XML, TAP output                        |

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- An Anthropic API key

### Installation

```bash
# Clone the repository
git clone https://github.com/sjnims/cc-plugin-eval.git
cd cc-plugin-eval

# Install dependencies
npm install

# Build
npm run build

# Create .env file with your API key
echo "ANTHROPIC_API_KEY=sk-ant-your-key-here" > .env
```

### Run Your First Evaluation

```bash
# See cost estimate without running (recommended first)
npx cc-plugin-eval run -p ./path/to/your/plugin --dry-run

# Run full evaluation
npx cc-plugin-eval run -p ./path/to/your/plugin
```

## How It Works

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                           cc-plugin-eval Pipeline                           │
└─────────────────────────────────────────────────────────────────────────────┘

  Plugin Directory
        │
        ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   Stage 1:    │    │   Stage 2:    │    │   Stage 3:    │    │   Stage 4:    │
│   Analysis    │───▶│  Generation   │───▶│  Execution    │───▶│  Evaluation   │
│               │    │               │    │               │    │               │
│ Parse plugin  │    │ Create test   │    │ Run scenarios │    │ Detect which  │
│ structure,    │    │ scenarios     │    │ via Agent SDK │    │ components    │
│ extract       │    │ (positive &   │    │ with tool     │    │ triggered,    │
│ triggers      │    │ negative)     │    │ capture       │    │ calculate     │
│               │    │               │    │               │    │ metrics       │
└───────────────┘    └───────────────┘    └───────────────┘    └───────────────┘
        │                    │                    │                    │
        ▼                    ▼                    ▼                    ▼
   analysis.json       scenarios.json       transcripts/        evaluation.json
```

### Stage Details

| Stage             | Purpose                                         | Method                                            | Output            |
| ----------------- | ----------------------------------------------- | ------------------------------------------------- | ----------------- |
| **1. Analysis**   | Parse plugin structure, extract trigger phrases | Deterministic parsing                             | `analysis.json`   |
| **2. Generation** | Create test scenarios                           | LLM for skills/agents, deterministic for commands | `scenarios.json`  |
| **3. Execution**  | Run scenarios against Claude Agent SDK          | PreToolUse hook captures                          | `transcripts/`    |
| **4. Evaluation** | Detect triggers, calculate metrics              | Programmatic first, LLM judge for quality         | `evaluation.json` |

### Scenario Types

Each component generates multiple scenario types to thoroughly test triggering:

| Type          | Description                  | Example                                |
| ------------- | ---------------------------- | -------------------------------------- |
| `direct`      | Exact trigger phrase         | "create a skill"                       |
| `paraphrased` | Same intent, different words | "add a new skill to my plugin"         |
| `edge_case`   | Unusual but valid            | "skill plz"                            |
| `negative`    | Should NOT trigger           | "tell me about database skills"        |
| `semantic`    | Synonym variations           | "generate a skill" vs "create a skill" |

## CLI Reference

### Full Pipeline

```bash
# Run complete evaluation
cc-plugin-eval run -p ./plugin

# With options
cc-plugin-eval run -p ./plugin \
  --config custom-config.yaml \
  --verbose \
  --samples 3
```

### Individual Stages

```bash
# Stage 1: Analysis only
cc-plugin-eval analyze -p ./plugin

# Stages 1-2: Analysis + Generation
cc-plugin-eval generate -p ./plugin

# Stages 1-3: Analysis + Generation + Execution
cc-plugin-eval execute -p ./plugin
```

### Resume & Reporting

```bash
# Resume an interrupted run
cc-plugin-eval resume -r <run-id>

# List previous runs
cc-plugin-eval list -p ./plugin

# Generate report from existing results
cc-plugin-eval report -r <run-id> --output junit-xml
```

### Common Options

| Option                | Description                                       |
| --------------------- | ------------------------------------------------- |
| `-p, --plugin <path>` | Plugin directory path                             |
| `-c, --config <path>` | Config file (default: `config.yaml`)              |
| `--dry-run`           | Generate scenarios without execution              |
| `--verbose`           | Enable debug output                               |
| `--fast`              | Only run previously failed scenarios              |
| `--semantic`          | Enable semantic variation testing                 |
| `--samples <n>`       | Multi-sample judgment count                       |
| `--reps <n>`          | Repetitions per scenario                          |
| `--output <format>`   | Output format: `json`, `yaml`, `junit-xml`, `tap` |

## Configuration

Configuration is managed via `config.yaml`. Here's a quick reference:

### Scope (What to Test)

```yaml
scope:
  skills: true # Evaluate skill components
  agents: true # Evaluate agent components
  commands: true # Evaluate command components
  hooks: false # Evaluate hook components
  mcp_servers: false # Evaluate MCP server components
```

### Generation (Stage 2)

```yaml
generation:
  model: "claude-sonnet-4-5-20250929"
  scenarios_per_component: 5 # Test scenarios per component
  diversity: 0.7 # 0.0-1.0, higher = more unique scenarios
  semantic_variations: true # Generate synonym variations
```

### Execution (Stage 3)

```yaml
execution:
  model: "claude-sonnet-4-20250514"
  max_turns: 5 # Conversation turns per scenario
  timeout_ms: 60000 # Timeout per scenario (1 min)
  max_budget_usd: 10.0 # Stop if cost exceeds this
  disallowed_tools: # Safety: block file operations
    - Write
    - Edit
    - Bash
```

### Evaluation (Stage 4)

```yaml
evaluation:
  model: "claude-sonnet-4-5-20250929"
  detection_mode: "programmatic_first" # Or "llm_only"
  num_samples: 1 # Multi-sample judgment
```

See the full [`config.yaml`](./config.yaml) for all options, including:

- **`tuning`**: Fine-tune timeouts, retry behavior, and token estimates
- **`conflict_detection`**: Detect when multiple components trigger for the same prompt
- **`batch_threshold`**: Use Anthropic Batches API for cost savings (50% discount)
- **`sanitization`**: PII redaction with ReDoS-safe custom patterns

## Performance Optimization

### Session Batching (Default)

By default, scenarios testing the same component share a session with `/clear` between them. This reduces subprocess overhead by ~80%:

| Mode              | Overhead per Scenario | 100 Scenarios |
| ----------------- | --------------------- | ------------- |
| Batched (default) | ~1-2s after first     | ~2-3 minutes  |
| Isolated          | ~5-8s each            | ~8-13 minutes |

The `/clear` command resets conversation history between scenarios while reusing the subprocess and loaded plugin.

### When to Use Isolated Mode

Switch to isolated mode when you need complete separation between scenarios:

- Testing plugins that modify filesystem state
- Debugging cross-contamination issues between scenarios
- When using `rewind_file_changes: true` (automatically uses isolated mode)

To use isolated mode:

```yaml
execution:
  session_strategy: "isolated"
```

Or via the deprecated (but still supported) option:

```yaml
execution:
  session_isolation: true
```

## Output Structure

After a run, results are saved to:

```text
results/
└── {plugin-name}/
    └── {run-id}/
        ├── state.json              # Pipeline state (for resume)
        ├── analysis.json           # Stage 1: Parsed components
        ├── scenarios.json          # Stage 2: Generated test cases
        ├── execution-metadata.json # Stage 3: Execution stats
        ├── evaluation.json         # Stage 4: Results & metrics
        └── transcripts/
            └── {scenario-id}.json  # Individual execution transcripts
```

### Sample Evaluation Output

```json
{
  "results": [
    {
      "scenario_id": "skill-create-direct-001",
      "triggered": true,
      "confidence": 100,
      "quality_score": 9.2,
      "detection_source": "programmatic",
      "has_conflict": false
    }
  ],
  "metrics": {
    "total_scenarios": 25,
    "accuracy": 0.92,
    "trigger_rate": 0.88,
    "avg_quality": 8.7,
    "conflict_count": 1
  }
}
```

## Detection Strategy

**Programmatic detection is primary** for maximum accuracy:

1. During execution, PreToolUse hooks capture all tool invocations
2. Tool captures are parsed to detect `Skill`, `Task`, and `SlashCommand` calls
3. MCP tools detected via pattern: `mcp__<server>__<tool>`
4. Hooks detected via `SDKHookResponseMessage` events
5. Confidence is 100% for programmatic detection

**LLM judge is secondary**, used for:

- Quality assessment (0-10 score)
- Edge cases where programmatic detection is ambiguous
- Multi-sample consensus when configured

## Development

### Build & Test

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint

# Type check
npm run typecheck
```

### Run Specific Tests

```bash
# Single test file
npx vitest run tests/unit/stages/1-analysis/skill-analyzer.test.ts

# Tests matching pattern
npx vitest run -t "SkillAnalyzer"

# E2E tests (requires API key, costs money)
RUN_E2E_TESTS=true npm test -- tests/e2e/
```

### Additional Linters

```bash
# Prettier (formatting)
npx prettier --check "src/**/*.ts" "*.json" "*.md"

# Markdown
markdownlint "*.md"

# YAML
uvx yamllint -c .yamllint.yml config.yaml

# GitHub Actions
actionlint .github/workflows/*.yml
```

### Project Structure

```text
src/
├── index.ts              # CLI entry point
├── env.ts                # Environment setup (dotenv)
├── config/               # Configuration loading & validation
│   ├── loader.ts         # YAML/JSON config loading with Zod
│   ├── schema.ts         # Zod validation schemas
│   ├── defaults.ts       # Default configuration values
│   └── pricing.ts        # Model pricing for cost estimation
├── stages/
│   ├── 1-analysis/       # Plugin parsing, trigger extraction
│   │   ├── plugin-parser.ts
│   │   ├── skill-analyzer.ts
│   │   ├── agent-analyzer.ts
│   │   ├── command-analyzer.ts
│   │   ├── hook-analyzer.ts
│   │   ├── mcp-analyzer.ts
│   │   ├── path-resolver.ts
│   │   └── preflight.ts
│   ├── 2-generation/     # Scenario generation
│   │   ├── skill-scenario-generator.ts
│   │   ├── agent-scenario-generator.ts
│   │   ├── command-scenario-generator.ts
│   │   ├── hook-scenario-generator.ts
│   │   ├── mcp-scenario-generator.ts
│   │   ├── semantic-generator.ts
│   │   ├── cost-estimator.ts
│   │   ├── batch-calculator.ts
│   │   └── diversity-manager.ts
│   ├── 3-execution/      # Agent SDK integration
│   │   ├── agent-executor.ts
│   │   ├── plugin-loader.ts
│   │   ├── sdk-client.ts
│   │   ├── hook-capture.ts
│   │   ├── session-batching.ts
│   │   ├── transcript-builder.ts
│   │   └── progress-reporters.ts
│   └── 4-evaluation/     # Detection & metrics
│       ├── programmatic-detector.ts
│       ├── llm-judge.ts
│       ├── metrics.ts
│       ├── conflict-tracker.ts
│       ├── batch-evaluator.ts
│       └── multi-sampler.ts
├── state/                # Resume capability
│   └── state-manager.ts
├── types/                # TypeScript interfaces
└── utils/                # Retry, concurrency, logging
    ├── retry.ts
    ├── concurrency.ts
    ├── sanitizer.ts
    ├── logging.ts
    └── file-io.ts

tests/
├── unit/                 # Unit tests (mirror src/ structure)
├── integration/          # Integration tests
├── e2e/                  # End-to-end tests (real SDK calls)
├── mocks/                # Mock implementations
└── fixtures/             # Test data and mock plugins
```

## Roadmap

- [x] Phase 1: Skills, agents, commands evaluation
- [x] Phase 2: Hooks evaluation (PR #58)
- [x] Phase 3: MCP servers evaluation (PR #63)
- [ ] Phase 4: Cross-plugin conflict detection
- [ ] Phase 5: Marketplace evaluation

## Security Considerations

### Permission Bypass

By default, `execution.permission_bypass: true` automatically approves all permission prompts during evaluation. This is required for automated evaluation but means:

- The Claude agent can perform any action the allowed tools permit
- Use `disallowed_tools` to restrict dangerous operations
- Consider running evaluations in isolated environments for untrusted plugins

### Default Tool Restrictions

The default `disallowed_tools: [Write, Edit, Bash]` prevents file modifications and shell commands during evaluation. Modify with caution:

- Enable `Write`/`Edit` only if testing file-modifying plugins
- Enable `Bash` only if testing shell-executing plugins
- Use `rewind_file_changes: true` to restore files after each scenario

### Sensitive Data

- API keys are loaded from environment variables, never stored in config
- PII sanitization is available but **disabled by default**
- Enable via `output.sanitize_logs` and `output.sanitize_transcripts` in config
- Custom sanitization patterns are validated for ReDoS safety
- Transcripts may contain user-provided data; enable sanitization or review before sharing

### Plugin Loading

Only local plugins are supported (`plugin.path`). There is no remote plugin loading, reducing supply chain risks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and pull request guidelines.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) code of conduct.

## License

[MIT](LICENSE)

## Author

Steve Nims ([@sjnims](https://github.com/sjnims))
