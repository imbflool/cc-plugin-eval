/**
 * MCP Scenario Generator - Deterministic scenario generation for MCP servers.
 *
 * MCP servers provide external tools via the Model Context Protocol. Test scenarios must:
 * - Cause Claude to invoke MCP tools that would be provided by the server
 * - Include scenarios for server types that require authentication
 * - Test common operations like file access, API calls, etc.
 *
 * Unlike skills (semantic matching), MCP tools are deterministic - the same task
 * should always invoke the same MCP tool. This allows for deterministic scenario
 * generation without LLM calls.
 */

import type { McpComponent, TestScenario } from "../../types/index.js";

/**
 * Server type to common operations mapping.
 * Each server type has typical operations that would invoke its tools.
 */
const SERVER_TYPE_PROMPTS = {
  github: [
    "Create a new GitHub issue titled 'Bug Report' in this repository",
    "List all open pull requests in the current repository",
    "Get the contents of the README.md file from GitHub",
    "Search for issues containing 'authentication' in the labels",
  ],
  filesystem: [
    "List all files in the /tmp directory",
    "Read the contents of a configuration file",
    "Create a new file with some test content",
    "Check if a specific file exists in the current directory",
  ],
  weather: [
    "What is the current weather in San Francisco?",
    "Get the 5-day weather forecast for New York",
    "Check if it will rain tomorrow in Seattle",
  ],
  database: [
    "Query the users table for all active accounts",
    "Insert a new record into the logs table",
    "Get the count of orders from the last week",
  ],
  slack: [
    "Send a message to the #general channel",
    "List all channels in the workspace",
    "Get the recent messages from a specific channel",
  ],
  api: [
    "Make an API request to fetch user data",
    "Call the external service to get status information",
    "Send data to the webhook endpoint",
  ],
  search: [
    "Search for documents containing 'architecture'",
    "Find all files modified in the last week",
    "Query the index for related content",
  ],
} as const;

/**
 * Get a prompt that would typically invoke an MCP server's tools.
 *
 * Uses server name to infer likely operations.
 *
 * @param serverName - Name of the MCP server
 * @param toolName - Optional specific tool name
 * @returns Prompt that should invoke the MCP tool
 *
 * @example
 * ```typescript
 * getMcpToolPrompt("github", "create_issue");
 * // "Create a new GitHub issue titled 'Bug Report' in this repository"
 *
 * getMcpToolPrompt("filesystem");
 * // "List all files in the /tmp directory"
 * ```
 */
export function getMcpToolPrompt(
  serverName: string,
  toolName?: string,
): string {
  // Try to match server name to known types
  const lowerName = serverName.toLowerCase();

  // Direct match on server type prompts
  for (const [type, prompts] of Object.entries(SERVER_TYPE_PROMPTS)) {
    if (lowerName.includes(type)) {
      // Return first prompt for the type
      return prompts[0];
    }
  }

  // If tool name provided, try to infer from it
  if (toolName) {
    const lowerTool = toolName.toLowerCase();

    if (lowerTool.includes("read") || lowerTool.includes("get")) {
      return `Use the MCP tool ${serverName}:${toolName} to retrieve data`;
    }
    if (lowerTool.includes("write") || lowerTool.includes("create")) {
      return `Use the MCP tool ${serverName}:${toolName} to create new data`;
    }
    if (lowerTool.includes("list") || lowerTool.includes("search")) {
      return `Use the MCP tool ${serverName}:${toolName} to find items`;
    }
    if (lowerTool.includes("delete") || lowerTool.includes("remove")) {
      return `Use the MCP tool ${serverName}:${toolName} to remove an item`;
    }
  }

  // Generic fallback
  return `Use the MCP server "${serverName}" to perform the required operation`;
}

/**
 * Get negative prompt for an MCP server.
 *
 * Returns a prompt that should NOT invoke this server's tools.
 *
 * @param serverName - Name of the MCP server to NOT trigger
 * @returns Prompt that should not trigger this server
 */
function getNegativePrompt(serverName: string): string {
  const lowerName = serverName.toLowerCase();

  // Return prompts for OTHER domains
  if (lowerName.includes("github")) {
    return "What is the current weather forecast?";
  }
  if (lowerName.includes("filesystem") || lowerName.includes("file")) {
    return "Send a Slack message to the team";
  }
  if (lowerName.includes("weather")) {
    return "Create a new GitHub repository";
  }
  if (lowerName.includes("slack")) {
    return "Read the contents of package.json file";
  }
  if (lowerName.includes("database") || lowerName.includes("db")) {
    return "Check the weather in London";
  }

  // Generic: ask about something unrelated
  return "What is 2 + 2? Just tell me the answer without using any tools.";
}

/**
 * Generate scenarios for an MCP server component.
 *
 * Creates deterministic test scenarios that should trigger MCP tool usage.
 *
 * @param mcp - MCP server component
 * @returns Array of test scenarios
 *
 * @example
 * ```typescript
 * const github = { name: "github", serverType: "stdio", ... };
 * const scenarios = generateMcpScenarios(github);
 * ```
 */
export function generateMcpScenarios(mcp: McpComponent): TestScenario[] {
  const scenarios: TestScenario[] = [];
  const serverName = mcp.name || "unnamed-server";
  const baseId = serverName.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();

  // Direct invocation scenario
  scenarios.push({
    id: `${baseId}-direct`,
    component_ref: serverName,
    component_type: "mcp_server",
    scenario_type: "direct",
    user_prompt: getMcpToolPrompt(serverName),
    expected_trigger: true,
    expected_component: serverName,
    reasoning: `Direct scenario for ${mcp.serverType} MCP server "${serverName}" - should invoke server tools`,
  });

  // Add variation scenario based on server type
  const lowerName = serverName.toLowerCase();
  const typePrompts = Object.entries(SERVER_TYPE_PROMPTS).find(([type]) =>
    lowerName.includes(type),
  );

  const variationPrompt = typePrompts?.[1]?.[1];
  if (variationPrompt) {
    scenarios.push({
      id: `${baseId}-variation`,
      component_ref: serverName,
      component_type: "mcp_server",
      scenario_type: "paraphrased",
      user_prompt: variationPrompt,
      expected_trigger: true,
      expected_component: serverName,
      reasoning: `Variation scenario for ${serverName} - different operation same server`,
    });
  }

  // Negative scenario - prompt that should NOT trigger this server
  scenarios.push({
    id: `${baseId}-negative`,
    component_ref: serverName,
    component_type: "mcp_server",
    scenario_type: "negative",
    user_prompt: getNegativePrompt(serverName),
    expected_trigger: false,
    expected_component: serverName,
    reasoning: `Negative scenario - task should NOT require "${serverName}" MCP server`,
  });

  // Auth-required scenario for servers needing authentication
  if (mcp.authRequired) {
    scenarios.push({
      id: `${baseId}-auth-required`,
      component_ref: serverName,
      component_type: "mcp_server",
      scenario_type: "edge_case",
      user_prompt: getMcpToolPrompt(serverName),
      expected_trigger: true,
      expected_component: serverName,
      reasoning: `Auth-required scenario - server "${serverName}" requires authentication (${mcp.envVars.join(", ")})`,
    });
  }

  return scenarios;
}

/**
 * Generate scenarios for all MCP server components.
 *
 * @param mcpServers - Array of MCP server components
 * @returns Array of all test scenarios
 */
export function generateAllMcpScenarios(
  mcpServers: McpComponent[],
): TestScenario[] {
  const scenarios: TestScenario[] = [];

  for (const mcp of mcpServers) {
    scenarios.push(...generateMcpScenarios(mcp));
  }

  return scenarios;
}

/**
 * Get expected scenario count for MCP servers.
 *
 * Calculates the number of test scenarios that will be generated for the
 * given MCP servers. Used for cost estimation before scenario generation.
 *
 * @param mcpServers - Array of MCP server components
 * @returns Expected scenario count
 *
 * @example
 * ```typescript
 * const servers = analyzeMcpServers("/path/to/.mcp.json");
 * const count = getExpectedMcpScenarioCount(servers);
 * console.log(`Will generate approximately ${count} scenarios`);
 * ```
 */
export function getExpectedMcpScenarioCount(
  mcpServers: McpComponent[],
): number {
  let count = 0;

  for (const mcp of mcpServers) {
    // Base scenarios: direct + negative = 2
    count += 2;

    // Check if we'd generate a variation scenario
    const lowerName = mcp.name.toLowerCase();
    const hasTypePrompts = Object.entries(SERVER_TYPE_PROMPTS).some(
      ([type, prompts]) => lowerName.includes(type) && prompts.length > 1,
    );
    if (hasTypePrompts) {
      count += 1; // Variation scenario
    }

    // Auth-required scenario
    if (mcp.authRequired) {
      count += 1;
    }
  }

  return count;
}
