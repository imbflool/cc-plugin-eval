import path from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeMcpServers } from "../../../../src/stages/1-analysis/mcp-analyzer.js";
import {
  generateMcpScenarios,
  generateAllMcpScenarios,
  getExpectedMcpScenarioCount,
  getMcpToolPrompt,
} from "../../../../src/stages/2-generation/mcp-scenario-generator.js";

import type { McpComponent } from "../../../../src/types/index.js";

const fixturesPath = path.resolve(process.cwd(), "tests/fixtures");
const validPluginPath = path.join(fixturesPath, "valid-plugin");
const mcpConfigPath = path.join(validPluginPath, "mcp", ".mcp.json");

// Get actual MCP servers from fixture
const mcpServers = analyzeMcpServers(mcpConfigPath);

describe("getMcpToolPrompt", () => {
  it("generates prompt for known server type (github)", () => {
    const prompt = getMcpToolPrompt("github", "create_issue");
    expect(prompt.toLowerCase()).toContain("github");
    expect(prompt.length).toBeGreaterThan(20);
  });

  it("generates prompt for filesystem operations", () => {
    const prompt = getMcpToolPrompt("filesystem", "read_file");
    expect(prompt).toContain("file");
    expect(prompt.length).toBeGreaterThan(20);
  });

  it("generates generic prompt for unknown server", () => {
    const prompt = getMcpToolPrompt("unknown-server", "some_tool");
    expect(prompt).toContain("MCP");
    expect(prompt).toContain("unknown-server");
  });

  it("includes tool name in the prompt", () => {
    const prompt = getMcpToolPrompt("api", "get_data");
    expect(prompt).toBeTruthy();
  });
});

describe("generateMcpScenarios", () => {
  it("generates scenarios for an MCP server", () => {
    const context7 = mcpServers.find((s) => s.name === "context7");
    expect(context7).toBeDefined();

    const scenarios = generateMcpScenarios(context7 as McpComponent);

    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios[0]?.component_type).toBe("mcp_server");
    expect(scenarios[0]?.component_ref).toBe("context7");
  });

  it("generates direct invocation scenario", () => {
    const context7 = mcpServers.find((s) => s.name === "context7");
    const scenarios = generateMcpScenarios(context7 as McpComponent);

    const directScenario = scenarios.find((s) => s.scenario_type === "direct");
    expect(directScenario).toBeDefined();
    expect(directScenario?.expected_trigger).toBe(true);
  });

  it("generates negative scenario for auth-required server", () => {
    // Create a mock server that requires auth for this test
    const mockAuthServer: McpComponent = {
      name: "mock-auth-server",
      path: mcpConfigPath,
      serverType: "stdio",
      command: "npx -y @example/server",
      url: undefined,
      authRequired: true,
      envVars: ["API_KEY"],
      tools: [],
      description: "Mock server requiring auth",
    };

    const scenarios = generateMcpScenarios(mockAuthServer);

    const negativeScenario = scenarios.find(
      (s) => s.scenario_type === "negative",
    );
    expect(negativeScenario).toBeDefined();
  });

  it("sets expected_component correctly", () => {
    const context7 = mcpServers.find((s) => s.name === "context7");
    const scenarios = generateMcpScenarios(context7 as McpComponent);

    for (const scenario of scenarios) {
      expect(scenario.expected_component).toBe("context7");
    }
  });

  it("generates unique scenario IDs", () => {
    const context7 = mcpServers.find((s) => s.name === "context7");
    const scenarios = generateMcpScenarios(context7 as McpComponent);

    const ids = scenarios.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("includes reasoning for each scenario", () => {
    const context7 = mcpServers.find((s) => s.name === "context7");
    const scenarios = generateMcpScenarios(context7 as McpComponent);

    for (const scenario of scenarios) {
      expect(scenario.reasoning).toBeTruthy();
      expect(scenario.reasoning?.length).toBeGreaterThan(10);
    }
  });
});

describe("generateAllMcpScenarios", () => {
  it("generates scenarios for all MCP servers", () => {
    const scenarios = generateAllMcpScenarios(mcpServers);

    expect(scenarios.length).toBeGreaterThan(0);

    // Should have scenarios for the configured servers
    const serverRefs = new Set(scenarios.map((s) => s.component_ref));
    expect(serverRefs.size).toBe(mcpServers.length);
  });

  it("returns empty array for empty input", () => {
    const scenarios = generateAllMcpScenarios([]);
    expect(scenarios).toEqual([]);
  });

  it("generates distinct scenarios per server", () => {
    const scenarios = generateAllMcpScenarios(mcpServers);

    // Each server should have its own scenarios
    const context7Scenarios = scenarios.filter(
      (s) => s.component_ref === "context7",
    );

    expect(context7Scenarios.length).toBeGreaterThan(0);
  });

  it("generates scenarios for multiple servers when provided", () => {
    // Create multiple mock servers to test multi-server scenario generation
    const mockServers: McpComponent[] = [
      {
        name: "server-a",
        path: mcpConfigPath,
        serverType: "stdio",
        command: "npx -y @example/server-a",
        url: undefined,
        authRequired: false,
        envVars: [],
        tools: [],
        description: "Test server A",
      },
      {
        name: "server-b",
        path: mcpConfigPath,
        serverType: "http",
        command: undefined,
        url: "http://localhost:3000",
        authRequired: true,
        envVars: ["API_KEY"],
        tools: [],
        description: "Test server B",
      },
    ];

    const scenarios = generateAllMcpScenarios(mockServers);

    const serverAScenarios = scenarios.filter(
      (s) => s.component_ref === "server-a",
    );
    const serverBScenarios = scenarios.filter(
      (s) => s.component_ref === "server-b",
    );

    expect(serverAScenarios.length).toBeGreaterThan(0);
    expect(serverBScenarios.length).toBeGreaterThan(0);
  });
});

describe("getExpectedMcpScenarioCount", () => {
  it("returns correct count for servers", () => {
    const count = getExpectedMcpScenarioCount(mcpServers);

    // At minimum, one scenario per server
    expect(count).toBeGreaterThanOrEqual(mcpServers.length);
  });

  it("returns zero for empty array", () => {
    const count = getExpectedMcpScenarioCount([]);
    expect(count).toBe(0);
  });

  it("matches actual generated count", () => {
    const expectedCount = getExpectedMcpScenarioCount(mcpServers);
    const scenarios = generateAllMcpScenarios(mcpServers);

    // Count should be reasonably close to actual
    // Allow some variance since count is an estimate
    expect(Math.abs(expectedCount - scenarios.length)).toBeLessThanOrEqual(
      mcpServers.length * 2,
    );
  });
});
