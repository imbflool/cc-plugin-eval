import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  analyzeMcpServers,
  analyzeMcp,
  inferAuthRequired,
  extractEnvVars,
  inferServerType,
} from "../../../../src/stages/1-analysis/mcp-analyzer.js";

const fixturesPath = path.resolve(process.cwd(), "tests/fixtures");
const validPluginPath = path.join(fixturesPath, "valid-plugin");
const mcpConfigPath = path.join(validPluginPath, "mcp", ".mcp.json");
const malformedMcpPath = path.join(fixturesPath, "malformed-mcp-config.json");

describe("inferServerType", () => {
  it("infers stdio type from command", () => {
    const type = inferServerType({ command: "npx", args: ["-y", "server"] });
    expect(type).toBe("stdio");
  });

  it("infers sse type from url with explicit type", () => {
    const type = inferServerType({ type: "sse", url: "https://example.com" });
    expect(type).toBe("sse");
  });

  it("infers http type from localhost url", () => {
    const type = inferServerType({ url: "http://localhost:3000" });
    expect(type).toBe("http");
  });

  it("defaults to stdio when ambiguous", () => {
    const type = inferServerType({});
    expect(type).toBe("stdio");
  });
});

describe("inferAuthRequired", () => {
  it("detects OAuth environment variables", () => {
    const authRequired = inferAuthRequired({ env: { OAUTH_TOKEN: "xyz" } });
    expect(authRequired).toBe(true);
  });

  it("detects API key environment variables", () => {
    const authRequired = inferAuthRequired({
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
    });
    expect(authRequired).toBe(true);
  });

  it("detects auth headers", () => {
    const authRequired = inferAuthRequired({
      headers: { Authorization: "Bearer token" },
    });
    expect(authRequired).toBe(true);
  });

  it("returns false when no auth indicators", () => {
    const authRequired = inferAuthRequired({ command: "npx" });
    expect(authRequired).toBe(false);
  });
});

describe("extractEnvVars", () => {
  it("extracts environment variable names", () => {
    const vars = extractEnvVars({
      env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", HOME: "/home/user" },
    });
    expect(vars).toContain("GITHUB_TOKEN");
    expect(vars).toContain("HOME");
  });

  it("extracts variables from headers", () => {
    const vars = extractEnvVars({
      headers: { Authorization: "Bearer ${API_KEY}" },
    });
    expect(vars).toContain("API_KEY");
  });

  it("returns empty array when no env vars", () => {
    const vars = extractEnvVars({ command: "npx" });
    expect(vars).toEqual([]);
  });
});

describe("analyzeMcp", () => {
  it("parses stdio server correctly", () => {
    const servers = analyzeMcp(mcpConfigPath);
    const context7 = servers.find((s) => s.name === "context7");

    expect(context7).toBeDefined();
    expect(context7?.serverType).toBe("stdio");
    expect(context7?.command).toBe("npx");
    expect(context7?.authRequired).toBe(false);
    expect(context7?.envVars).toEqual([]);
  });

  it("parses all servers from config", () => {
    const servers = analyzeMcp(mcpConfigPath);

    expect(servers).toHaveLength(2);
    const names = servers.map((s) => s.name);
    expect(names).toContain("context7");
    expect(names).toContain("filesystem");
  });

  it("generates description for each server", () => {
    const servers = analyzeMcp(mcpConfigPath);

    for (const server of servers) {
      expect(server.description).toBeTruthy();
      expect(server.description.length).toBeGreaterThan(0);
    }
  });

  it("sets path correctly for all servers", () => {
    const servers = analyzeMcp(mcpConfigPath);

    for (const server of servers) {
      expect(server.path).toBe(mcpConfigPath);
    }
  });

  it("initializes tools as empty array", () => {
    const servers = analyzeMcp(mcpConfigPath);

    for (const server of servers) {
      expect(server.tools).toEqual([]);
    }
  });
});

describe("analyzeMcpServers", () => {
  it("returns empty array for non-existent file", () => {
    const servers = analyzeMcpServers("/non/existent/.mcp.json");
    expect(servers).toEqual([]);
  });

  it("analyzes servers from valid path", () => {
    const servers = analyzeMcpServers(mcpConfigPath);

    expect(servers.length).toBeGreaterThan(0);
    expect(servers.every((s) => s.path === mcpConfigPath)).toBe(true);
  });

  it("handles malformed JSON gracefully", () => {
    const servers = analyzeMcpServers(malformedMcpPath);
    expect(servers).toEqual([]);
  });
});
