/**
 * Preflight validation for plugins.
 * Catches errors before SDK initialization with actionable suggestions.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import type {
  PreflightError,
  PreflightResult,
  PreflightWarning,
} from "../../types/index.js";

/**
 * Dangerous system directories that should never contain plugins.
 *
 * These paths are selected because they:
 * - /etc/  - System configuration files (credentials, secrets, service configs)
 * - /sys/  - Linux kernel interface (device parameters, kernel settings)
 * - /proc/ - Process information pseudo-filesystem (memory maps, credentials)
 * - /root/ - Root user's home directory (SSH keys, shell history, credentials)
 *
 * Other directories like /var/log/, /usr/bin/, or macOS-specific /System/ are
 * not included as they are less likely to contain exploitable secrets and
 * blocking them would be overly restrictive for defense-in-depth purposes.
 *
 * @see https://owasp.org/www-community/attacks/Path_Traversal
 */
const DANGEROUS_UNIX_PATHS = ["/etc/", "/sys/", "/proc/", "/root/"];

/**
 * Validate path boundaries for security (defense-in-depth).
 *
 * Checks for:
 * 1. Dangerous system directories (Unix only) - returns error
 * 2. Paths outside current working directory - returns warning
 *
 * @param absolutePath - Already-resolved absolute path (via path.resolve())
 * @returns Object with optional error and optional warning
 */
function validatePathBoundaries(absolutePath: string): {
  error: PreflightError | null;
  warning: PreflightWarning | null;
} {
  let error: PreflightError | null = null;
  let warning: PreflightWarning | null = null;

  // Check for dangerous system directories (Unix only)
  if (process.platform !== "win32") {
    // Normalize with trailing separator to ensure accurate prefix matching.
    // This prevents false positives like "/etcetera" matching "/etc/".
    // Since absolutePath comes from path.resolve(), it's already normalized
    // without a trailing slash, so we add one for consistent comparison.
    const normalizedPath = path.normalize(absolutePath + path.sep);
    const matchedDangerousPath = DANGEROUS_UNIX_PATHS.find((p) =>
      normalizedPath.startsWith(p),
    );
    if (matchedDangerousPath) {
      error = {
        code: "PATH_DANGEROUS",
        message: `Plugin path accesses system directory: ${absolutePath}`,
        suggestion:
          "Plugin paths must not target system directories like /etc, /sys, /proc, or /root.",
      };
      return { error, warning };
    }
  }

  // Check if path is outside cwd (may be intentional for symlinks/monorepos)
  const cwd = process.cwd();
  // Same trailing separator technique for accurate prefix comparison
  const normalizedCwd = path.normalize(cwd + path.sep);
  const normalizedAbsolutePath = path.normalize(absolutePath + path.sep);
  if (!normalizedAbsolutePath.startsWith(normalizedCwd)) {
    warning = {
      code: "PATH_OUTSIDE_CWD",
      message: `Plugin path is outside current working directory: ${absolutePath}`,
    };
  }

  return { error, warning };
}

/**
 * Parse and validate manifest JSON content.
 *
 * @param manifestPath - Path to the manifest file
 * @returns Object with manifest data or error information
 */
function parseManifestJson(manifestPath: string): {
  manifest: Record<string, unknown> | null;
  error: PreflightError | null;
} {
  try {
    const content = readFileSync(manifestPath, "utf-8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
    const parsed = JSON.parse(content);

    // Validate JSON.parse result is an object
    if (typeof parsed !== "object" || parsed === null) {
      return {
        manifest: null,
        error: {
          code: "MANIFEST_INVALID",
          message: `plugin.json must be a JSON object, got ${parsed === null ? "null" : typeof parsed}`,
          suggestion:
            "Ensure plugin.json contains a JSON object (e.g., { ... }), not an array or primitive.",
        },
      };
    }

    return { manifest: parsed as Record<string, unknown>, error: null };
  } catch (err) {
    return {
      manifest: null,
      error: {
        code: "MANIFEST_PARSE_ERROR",
        message: `Invalid JSON in plugin.json: ${err instanceof Error ? err.message : String(err)}`,
        suggestion:
          "Validate your JSON syntax. Common issues: trailing commas, missing quotes.",
      },
    };
  }
}

/**
 * Validate plugin before SDK initialization.
 * Catches common errors early with actionable suggestions.
 *
 * Run this BEFORE calling verifyPluginLoad() to avoid cryptic SDK errors.
 *
 * @param pluginPath - Path to the plugin directory
 * @returns Preflight validation result
 */
export function preflightCheck(pluginPath: string): PreflightResult {
  const errors: PreflightError[] = [];
  const warnings: PreflightWarning[] = [];
  let pluginName: string | null = null;

  const absolutePath = path.resolve(pluginPath);
  let resolvedPath = absolutePath;
  const manifestPath = path.join(absolutePath, ".claude-plugin", "plugin.json");

  // 0. Path boundary validation (defense-in-depth)
  const { error: pathError, warning: pathWarning } =
    validatePathBoundaries(absolutePath);
  if (pathError) {
    errors.push(pathError);
    return {
      valid: false,
      pluginPath: absolutePath,
      resolvedPath,
      manifestPath,
      pluginName,
      errors,
      warnings,
    };
  }
  if (pathWarning) {
    warnings.push(pathWarning);
  }

  // 1. Verify plugin path exists
  if (!existsSync(absolutePath)) {
    errors.push({
      code: "PATH_NOT_FOUND",
      message: `Plugin path does not exist: ${absolutePath}`,
      suggestion:
        "Check the path in your config. Use absolute path or path relative to cwd.",
    });
    return {
      valid: false,
      pluginPath: absolutePath,
      resolvedPath,
      manifestPath,
      pluginName,
      errors,
      warnings,
    };
  }

  // 2. Resolve symlinks and warn if path is a symlink
  try {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      resolvedPath = realpathSync(absolutePath);
      warnings.push({
        code: "SYMLINK_RESOLVED",
        message: `Plugin path is a symlink: ${absolutePath} -> ${resolvedPath}`,
      });
    }
  } catch (err) {
    errors.push({
      code: "PATH_RESOLUTION_FAILED",
      message: `Could not resolve real path: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: "Check that the symlink target exists and is accessible.",
    });
    return {
      valid: false,
      pluginPath: absolutePath,
      resolvedPath,
      manifestPath,
      pluginName,
      errors,
      warnings,
    };
  }

  // Use resolved path for remaining checks
  const resolvedManifestPath = path.join(
    resolvedPath,
    ".claude-plugin",
    "plugin.json",
  );

  // 3. Verify plugin.json exists
  if (!existsSync(resolvedManifestPath)) {
    errors.push({
      code: "MANIFEST_NOT_FOUND",
      message: `Plugin manifest not found: ${resolvedManifestPath}`,
      suggestion:
        'Create .claude-plugin/plugin.json with at minimum: { "name": "your-plugin-name" }',
    });
    return {
      valid: false,
      pluginPath: absolutePath,
      resolvedPath,
      manifestPath: resolvedManifestPath,
      pluginName,
      errors,
      warnings,
    };
  }

  // 4. Verify manifest is valid JSON
  const { manifest, error: parseError } =
    parseManifestJson(resolvedManifestPath);

  if (parseError) {
    errors.push(parseError);
    return {
      valid: false,
      pluginPath: absolutePath,
      resolvedPath,
      manifestPath: resolvedManifestPath,
      pluginName,
      errors,
      warnings,
    };
  }

  // manifest is guaranteed non-null when parseError is null
  if (!manifest) {
    // This should never happen, but satisfies TypeScript
    throw new Error("Unexpected null manifest without parse error");
  }

  // 5. Validate required fields
  if (typeof manifest["name"] !== "string" || !manifest["name"]) {
    errors.push({
      code: "MANIFEST_INVALID",
      message: 'Plugin manifest missing required "name" field',
      suggestion: 'Add "name": "your-plugin-name" to plugin.json',
    });
  } else {
    pluginName = manifest["name"];

    // Validate name format (kebab-case)
    if (!/^[a-z][a-z0-9-]*$/.test(pluginName)) {
      warnings.push({
        code: "NAME_FORMAT",
        message: `Plugin name "${pluginName}" should be kebab-case (lowercase with hyphens)`,
      });
    }
  }

  // 6. Check for common component directories
  const expectedDirs = ["skills", "agents", "commands"];
  const existingDirs = expectedDirs.filter((dir) =>
    existsSync(path.join(resolvedPath, dir)),
  );

  if (existingDirs.length === 0) {
    warnings.push({
      code: "NO_COMPONENTS",
      message:
        "No standard component directories found (skills/, agents/, commands/)",
    });
  }

  return {
    valid: errors.length === 0,
    pluginPath: absolutePath,
    resolvedPath,
    manifestPath: resolvedManifestPath,
    pluginName,
    errors,
    warnings,
  };
}

/**
 * Format preflight result for console output.
 *
 * @param result - Preflight result
 * @returns Formatted string
 */
export function formatPreflightResult(result: PreflightResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push(`✅ Plugin preflight passed: ${result.pluginName ?? "unknown"}`);
  } else {
    lines.push("❌ Plugin preflight check failed:");
    for (const err of result.errors) {
      lines.push(`  [${err.code}] ${err.message}`);
      lines.push(`  💡 ${err.suggestion}`);
    }
  }

  for (const warn of result.warnings) {
    lines.push(`⚠️  [${warn.code}] ${warn.message}`);
  }

  return lines.join("\n");
}
