# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **BREAKING**: Default execution strategy changed from isolated to batched mode
  for ~80% faster startup. Scenarios testing the same component now share a session
  with `/clear` between them. To restore previous behavior, set
  `execution.session_strategy: "isolated"` or `execution.session_isolation: true`
  in your config. (#86)

## [0.2.0] - 2026-01-10

### Added

- MCP server evaluation with tool detection via `mcp__<server>__<tool>` pattern (#63)
- Hooks evaluation with SDKHookResponseMessage event detection (#58, #49)
- E2E integration tests with real Claude Agent SDK (#68)
- ReDoS protection for custom sanitization patterns (#66)

### Changed

- Modernized CI workflows with updated action versions (#64, #65)
- Updated dependencies: zod 4.3.5, glob 13.0.0 (#54, #55)
- Improved README and CLAUDE.md documentation (#69)

### Fixed

- CI not failing on codecov errors for Dependabot PRs
- CLI `--version` now reads from package.json instead of hardcoded value

## [0.1.0] - 2026-01-02

### Added

- Initial 4-stage evaluation pipeline (Analysis → Generation → Execution → Evaluation)
- Support for skills, agents, and commands evaluation
- Programmatic detection via tool capture parsing
- LLM judge for quality assessment with multi-sampling
- Resume capability with state checkpointing
- Cost estimation before execution (dry-run mode)
- Multiple output formats (JSON, YAML, JUnit XML, TAP)
- Semantic variation testing for trigger robustness
- Rate limiter for API call protection (#32)
- Symlink resolution for plugin path validation (#33)
- PII filtering for verbose transcript logging (#34)
- Custom sanitization regex pattern validation (#46)
- Comprehensive test suite with 943 tests and 93%+ coverage

### Changed

- Tuning configuration extracted from hardcoded values (#26)
- Renamed seed.yaml to config.yaml for clarity (#25)

### Fixed

- Correct Anthropic structured output API usage in LLM judge (#9)
- Variance propagation from runJudgment to metrics (#30)
- Centralized logger and pricing utilities (#43)

[Unreleased]: https://github.com/sjnims/cc-plugin-eval/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sjnims/cc-plugin-eval/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sjnims/cc-plugin-eval/releases/tag/v0.1.0
