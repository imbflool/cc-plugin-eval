/**
 * Unit tests for plugin-loader.ts
 */

import { describe, expect, it } from "vitest";

import {
  getRecoveryHint,
  isPluginLoaded,
  areMcpServersHealthy,
  getFailedMcpServers,
  formatPluginLoadResult,
  verifyPluginLoad,
  type QueryFunction,
} from "../../../../src/stages/3-execution/plugin-loader.js";
import type {
  PluginLoadResult,
  ExecutionConfig,
} from "../../../../src/types/index.js";
import type {
  SDKMessage,
  SDKSystemMessage,
  QueryInput,
} from "../../../../src/stages/3-execution/sdk-client.js";

describe("getRecoveryHint", () => {
  it("should return hint for known error types", () => {
    expect(getRecoveryHint("manifest_not_found")).toContain("plugin.json");
    expect(getRecoveryHint("timeout")).toContain(
      "tuning.timeouts.plugin_load_ms",
    );
    expect(getRecoveryHint("mcp_connection_failed")).toContain("MCP server");
  });

  it("should return default hint for unknown error types", () => {
    const hint = getRecoveryHint("some_unknown_error");

    expect(hint).toContain("logs");
  });
});

describe("isPluginLoaded", () => {
  it("should return true for loaded plugin", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "test-plugin",
      plugin_path: "/path/to/plugin",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [],
      session_id: "session-123",
    };

    expect(isPluginLoaded(result)).toBe(true);
  });

  it("should return false for failed plugin", () => {
    const result: PluginLoadResult = {
      loaded: false,
      plugin_name: null,
      plugin_path: "/path/to/plugin",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [],
      session_id: "",
      error: "Plugin not found",
    };

    expect(isPluginLoaded(result)).toBe(false);
  });

  it("should return false when loaded but no plugin name", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: null,
      plugin_path: "/path/to/plugin",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [],
      session_id: "",
    };

    expect(isPluginLoaded(result)).toBe(false);
  });
});

describe("areMcpServersHealthy", () => {
  it("should return true when no MCP servers", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "test",
      plugin_path: "/path",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [],
      session_id: "",
    };

    expect(areMcpServersHealthy(result)).toBe(true);
  });

  it("should return true when all servers connected", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "test",
      plugin_path: "/path",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [
        { name: "github", status: "connected", tools: [] },
        { name: "postgres", status: "connected", tools: [] },
      ],
      session_id: "",
    };

    expect(areMcpServersHealthy(result)).toBe(true);
  });

  it("should return false when any server failed", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "test",
      plugin_path: "/path",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [
        { name: "github", status: "connected", tools: [] },
        {
          name: "postgres",
          status: "failed",
          tools: [],
          error: "Connection refused",
        },
      ],
      session_id: "",
    };

    expect(areMcpServersHealthy(result)).toBe(false);
  });

  it("should return false when server needs auth", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "test",
      plugin_path: "/path",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [{ name: "github", status: "needs-auth", tools: [] }],
      session_id: "",
    };

    expect(areMcpServersHealthy(result)).toBe(false);
  });
});

describe("getFailedMcpServers", () => {
  it("should return empty array when all healthy", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "test",
      plugin_path: "/path",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [{ name: "github", status: "connected", tools: [] }],
      session_id: "",
    };

    expect(getFailedMcpServers(result)).toEqual([]);
  });

  it("should return failed servers", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "test",
      plugin_path: "/path",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [
        { name: "github", status: "connected", tools: [] },
        {
          name: "postgres",
          status: "failed",
          tools: [],
          error: "Connection refused",
        },
        { name: "slack", status: "needs-auth", tools: [] },
      ],
      session_id: "",
    };

    const failed = getFailedMcpServers(result);

    expect(failed).toHaveLength(2);
    expect(failed.map((s) => s.name)).toEqual(["postgres", "slack"]);
  });
});

describe("formatPluginLoadResult", () => {
  it("should format successful load result", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "my-plugin",
      plugin_path: "/path/to/plugin",
      registered_tools: ["Skill", "Read", "Write"],
      registered_commands: ["/commit", "/review"],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [],
      session_id: "session-abc",
      diagnostics: {
        manifest_found: true,
        manifest_valid: true,
        components_discovered: {
          skills: 2,
          agents: 1,
          commands: 2,
          hooks: false,
          mcp_servers: 0,
        },
        load_duration_ms: 150,
      },
    };

    const formatted = formatPluginLoadResult(result);

    expect(formatted).toContain("my-plugin");
    expect(formatted).toContain("/path/to/plugin");
    expect(formatted).toContain("session-abc");
    expect(formatted).toContain("3"); // tools
    expect(formatted).toContain("2"); // commands
    expect(formatted).toContain("150ms");
  });

  it("should format failed load result", () => {
    const result: PluginLoadResult = {
      loaded: false,
      plugin_name: null,
      plugin_path: "/path/to/plugin",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [],
      session_id: "",
      error: "Plugin manifest not found",
      error_type: "manifest_not_found",
      recovery_hint: "Check plugin.json exists",
    };

    const formatted = formatPluginLoadResult(result);

    expect(formatted).toContain("failed to load");
    expect(formatted).toContain("Plugin manifest not found");
    expect(formatted).toContain("manifest_not_found");
    expect(formatted).toContain("Check plugin.json exists");
  });

  it("should format result with MCP servers", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "mcp-plugin",
      plugin_path: "/path",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [
        {
          name: "github",
          status: "connected",
          tools: ["create_issue", "list_repos"],
        },
        {
          name: "postgres",
          status: "failed",
          tools: [],
          error: "Connection refused",
        },
      ],
      session_id: "",
    };

    const formatted = formatPluginLoadResult(result);

    expect(formatted).toContain("MCP Servers: 2");
    expect(formatted).toContain("github");
    expect(formatted).toContain("connected");
    expect(formatted).toContain("2 tools");
    expect(formatted).toContain("postgres");
    expect(formatted).toContain("failed");
  });

  it("should format result with timing breakdown", () => {
    const result: PluginLoadResult = {
      loaded: true,
      plugin_name: "my-plugin",
      plugin_path: "/path/to/plugin",
      registered_tools: [],
      registered_commands: [],
      registered_skills: [],
      registered_agents: [],
      mcp_servers: [],
      session_id: "session-abc",
      diagnostics: {
        manifest_found: true,
        manifest_valid: true,
        components_discovered: {
          skills: 2,
          agents: 1,
          commands: 2,
          hooks: false,
          mcp_servers: 0,
        },
        load_duration_ms: 150,
        timing_breakdown: {
          time_to_first_message_ms: 50,
          time_to_init_message_ms: 120,
          total_query_time_ms: 150,
        },
      },
    };

    const formatted = formatPluginLoadResult(result);

    expect(formatted).toContain("Timing breakdown:");
    expect(formatted).toContain("First message: 50ms");
    expect(formatted).toContain("Init message: 120ms");
    expect(formatted).toContain("Total query: 150ms");
  });
});

describe("verifyPluginLoad timing", () => {
  const mockConfig: ExecutionConfig = {
    model: "claude-sonnet-4-20250514",
    session_strategy: "per_scenario",
    allowed_tools: [],
    disallowed_tools: [],
    mcp_servers: {
      skip_auth_required: true,
      connection_timeout_ms: 5000,
    },
  };

  /**
   * Create a mock query function that yields messages with configurable delays.
   */
  function createMockQueryFn(
    messages: SDKMessage[],
    delays: number[] = [],
  ): QueryFunction {
    return (_input: QueryInput) => {
      let index = 0;

      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) {
            if (delays[index]) {
              await new Promise((resolve) =>
                setTimeout(resolve, delays[index]),
              );
            }
            index++;
            yield message;
          }
        },
      };
    };
  }

  it("should capture timing breakdown on successful load", async () => {
    const initMessage: SDKSystemMessage = {
      type: "system",
      subtype: "init",
      session_id: "test-session",
      tools: [],
      slash_commands: [],
      plugins: [{ name: "test-plugin", path: "/path/to/plugin" }],
      mcp_servers: [],
    };

    const mockQueryFn = createMockQueryFn([initMessage], [50]);

    const result = await verifyPluginLoad({
      pluginPath: "/path/to/plugin",
      config: mockConfig,
      queryFn: mockQueryFn,
    });

    expect(result.loaded).toBe(true);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.timing_breakdown).toBeDefined();
    expect(
      result.diagnostics?.timing_breakdown?.time_to_first_message_ms,
    ).toBeGreaterThanOrEqual(0);
    expect(
      result.diagnostics?.timing_breakdown?.time_to_init_message_ms,
    ).toBeGreaterThanOrEqual(0);
    expect(
      result.diagnostics?.timing_breakdown?.total_query_time_ms,
    ).toBeGreaterThanOrEqual(0);
  });

  it("should capture timing breakdown when init message comes after other messages", async () => {
    const preInitMessage: SDKMessage = {
      type: "assistant",
      message: { role: "assistant", content: [] },
    };

    const initMessage: SDKSystemMessage = {
      type: "system",
      subtype: "init",
      session_id: "test-session",
      tools: [],
      slash_commands: [],
      plugins: [{ name: "test-plugin", path: "/path/to/plugin" }],
      mcp_servers: [],
    };

    const mockQueryFn = createMockQueryFn(
      [preInitMessage, initMessage],
      [20, 30],
    );

    const result = await verifyPluginLoad({
      pluginPath: "/path/to/plugin",
      config: mockConfig,
      queryFn: mockQueryFn,
    });

    expect(result.loaded).toBe(true);
    expect(result.diagnostics?.timing_breakdown).toBeDefined();
    // First message should arrive before init message
    expect(
      result.diagnostics!.timing_breakdown!.time_to_init_message_ms,
    ).toBeGreaterThanOrEqual(
      result.diagnostics!.timing_breakdown!.time_to_first_message_ms,
    );
  });

  it("should capture timing breakdown on failed load", async () => {
    const errorMessage: SDKMessage = {
      type: "error",
      error: "Plugin initialization failed",
    };

    const mockQueryFn = createMockQueryFn([errorMessage], [10]);

    const result = await verifyPluginLoad({
      pluginPath: "/path/to/plugin",
      config: mockConfig,
      queryFn: mockQueryFn,
    });

    expect(result.loaded).toBe(false);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.timing_breakdown).toBeDefined();
    expect(
      result.diagnostics?.timing_breakdown?.time_to_first_message_ms,
    ).toBeGreaterThanOrEqual(0);
  });
});
