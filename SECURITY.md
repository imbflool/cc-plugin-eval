# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

### Private Vulnerability Reporting

This repository has GitHub's private vulnerability reporting enabled:

1. Go to the [Security tab](https://github.com/sjnims/cc-plugin-eval/security) of this repository
2. Click "Report a vulnerability"
3. Fill out the vulnerability report form

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

### Response Timeline

| Phase                 | Timeline              |
| --------------------- | --------------------- |
| Initial response      | Within 48 hours       |
| Triage and assessment | Within 1 week         |
| Fix development       | Depends on severity   |
| Public disclosure     | After fix is released |

## Security Considerations

This tool executes LLM-generated scenarios against the Claude Agent SDK. Built-in safeguards include:

### Execution Safeguards

- **Disallowed tools**: Configure `execution.disallowed_tools` in `config.yaml` to block dangerous tools (e.g., `Write`, `Edit`, `Bash`)
- **Budget limits**: Set `execution.max_budget_usd` to cap API spending
- **Timeout limits**: Set `execution.timeout_ms` to prevent runaway executions
- **Session strategy**: Set `execution.session_strategy: "isolated"` to prevent cross-scenario contamination

### API Key Security

- Store your `ANTHROPIC_API_KEY` in `.env` (gitignored)
- Never commit API keys to the repository
- Use environment variables in CI/CD pipelines

## Enterprise & Production Configuration

### Threat Model

cc-plugin-eval executes LLM-generated test scenarios that invoke plugin components. In enterprise/production environments, consider these security boundaries:

| Boundary         | Risk                                                            | Mitigation                                                                |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Plugin Trust** | Untrusted plugins can execute arbitrary tool calls              | Only evaluate plugins from trusted sources; run in sandboxed environments |
| **PII Exposure** | Transcripts may contain sensitive data from plugin interactions | Enable sanitization for compliance requirements                           |
| **Tool Access**  | LLM can invoke any allowed tool during evaluation               | Use `disallowed_tools` to restrict dangerous operations                   |
| **Cost Control** | Large evaluations can incur significant API costs               | Set strict `max_budget_usd` limits                                        |

### PII Protection & Compliance

The `output.sanitization` feature redacts sensitive data from transcripts and logs. **It is disabled by default** for backwards compatibility but should be enabled in PII-sensitive environments.

#### When to Enable Sanitization

Enable `output.sanitization.enabled: true` if you:

- Handle personally identifiable information (PII)
- Must comply with GDPR, HIPAA, SOC 2, or similar regulations
- Share evaluation results with third parties
- Store transcripts in systems without equivalent redaction
- Audit or review plugin behavior involving user data

#### Built-in Redaction Patterns

The sanitizer includes production-tested patterns for:

- **API Keys**: Anthropic keys (`sk-ant-*`), generic API keys (`sk-*` with 32+ chars)
- **Tokens**: JWT tokens, Bearer tokens
- **Personal Data**: Email addresses, US phone numbers, Social Security Numbers
- **Financial**: Credit card numbers (various formats)

#### Configuration Example

```yaml
# config.yaml - Enable for PII-sensitive deployments
output:
  sanitize_transcripts: true # Redact saved transcript files
  sanitize_logs: true # Redact console output (verbose mode)
  sanitization:
    enabled: true
    custom_patterns: # Optional: domain-specific redaction
      - pattern: "INTERNAL-\\w+"
        replacement: "[REDACTED_INTERNAL_ID]"
      - pattern: "PATIENT-\\d{6}"
        replacement: "[REDACTED_PATIENT_ID]"
```

#### ReDoS Protection

Custom patterns are validated for Regular Expression Denial of Service (ReDoS) vulnerabilities. Patterns with nested quantifiers or overlapping alternations are rejected:

```yaml
# ❌ UNSAFE - Will be rejected
custom_patterns:
  - pattern: "(a+)+"           # Nested quantifiers
    replacement: "[REDACTED]"

# ✅ SAFE - Equivalent pattern without nesting
custom_patterns:
  - pattern: "a+"
    replacement: "[REDACTED]"
```

To bypass validation (only if you've verified pattern safety):

```yaml
output:
  sanitization:
    enabled: true
    pattern_safety_acknowledged: true # Disable ReDoS check
    custom_patterns:
      - pattern: "your-trusted-pattern"
        replacement: "[REDACTED]"
```

**Warning**: Bypassing ReDoS validation can make your evaluation vulnerable to denial-of-service attacks via maliciously crafted transcript content.

### Permission Bypass Mode

The `execution.permission_bypass` setting controls whether the SDK prompts for tool permission approval.

#### Default Behavior

**Default: `permission_bypass: true`** (automated evaluation mode)

This setting uses the SDK's `allowDangerouslySkipPermissions: true` option, which:

- ✅ Enables unattended evaluation (required for CI/CD)
- ✅ Allows scenarios to execute without user interaction
- ⚠️ Automatically approves all tool invocations
- ⚠️ Plugins can perform any action permitted by `allowed_tools`/`disallowed_tools`

#### When to Disable Permission Bypass

Set `permission_bypass: false` for:

- **Manual Plugin Review**: Evaluating plugins from unknown or untrusted sources
- **Interactive Testing**: When you want to inspect and approve each tool call
- **Security Audits**: Reviewing plugin behavior before production deployment

**Important**: Disabling permission bypass makes automation impossible, as the evaluation will pause waiting for user confirmation of tool invocations.

#### Configuration Example

```yaml
# Default: Automated evaluation (trust plugins)
execution:
  permission_bypass: true
  disallowed_tools: [Write, Edit, Bash]  # Restrict dangerous tools

# Manual review mode (untrusted plugins)
execution:
  permission_bypass: false  # SDK will prompt for each tool
  allowed_tools: [Read, Glob, Grep]  # Whitelist safe tools only
```

### Sandbox & Isolation Recommendations

For maximum security when evaluating untrusted plugins:

1. **Container Isolation**: Run cc-plugin-eval in Docker with:
   - Read-only filesystem (except `/tmp` and results directory)
   - No network access (if plugin doesn't require it)
   - Resource limits (CPU, memory)

2. **File System Protection**:

   ```yaml
   execution:
     disallowed_tools: [Write, Edit, Bash] # Block modifications
     session_strategy: "isolated" # Separate sessions
   rewind_file_changes: true # Restore files after each scenario
   ```

3. **Network Isolation**: Use firewall rules to restrict:
   - Outbound connections (allow only anthropic.com)
   - Inbound connections (none required)

4. **API Key Scoping**: Use API keys with:
   - Spend limits configured in Anthropic Console
   - Monitoring/alerting on unusual usage patterns

### Compliance Checklist

Use this checklist for enterprise/production deployments:

- [ ] Enable `output.sanitization.enabled: true` for PII environments
- [ ] Configure `custom_patterns` for domain-specific sensitive data
- [ ] Set restrictive `execution.disallowed_tools` (minimum: `[Write, Edit, Bash]`)
- [ ] Configure `execution.max_budget_usd` based on evaluation scope
- [ ] Store API keys in environment variables, never in config files
- [ ] Use `session_strategy: "isolated"` for untrusted plugins
- [ ] Run evaluations in sandboxed/containerized environments
- [ ] Review `ANTHROPIC_API_KEY` access controls and rotation policy
- [ ] Enable infrastructure-level audit logging if required (file system auditing, API call logging - not a built-in feature)
- [ ] Document plugin trust boundaries in internal security documentation

## Security Update Process

Security updates are released as patch versions and announced via:

- GitHub Security Advisories
- Release notes
