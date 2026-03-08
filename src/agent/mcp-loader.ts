import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { env } from "../config/env.js";
import type { McpConfig } from "../mcp/types.js";

/**
 * SDK MCP Server Config types (from @anthropic-ai/claude-agent-sdk)
 */
export interface SdkMcpStdioConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SdkMcpSSEConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type SdkMcpServerConfig = SdkMcpStdioConfig | SdkMcpSSEConfig;

/**
 * Loaded MCP configuration with tool tier mappings
 */
export interface LoadedMcpConfig {
  servers: Record<string, SdkMcpServerConfig>;
  toolTiers: Map<string, { tier: 1 | 2 | 3; serverName: string; originalName: string; guardrails?: string }>;
}

/**
 * Substitute environment variables in a string
 * Supports ${VAR_NAME} syntax
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const envValue = (env as Record<string, unknown>)[key];
    return typeof envValue === "string" ? envValue : String(envValue || "");
  });
}

/**
 * Load MCP server configuration from YAML file
 * Converts to SDK-compatible format
 */
export async function loadMcpConfig(configPath: string): Promise<LoadedMcpConfig> {
  const content = await readFile(configPath, "utf-8");
  const config = parseYaml(content) as McpConfig;

  const servers: Record<string, SdkMcpServerConfig> = {};
  const toolTiers = new Map<string, { tier: 1 | 2 | 3; serverName: string; originalName: string; guardrails?: string }>();

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    // Convert to SDK format
    if (serverConfig.type === "stdio") {
      if (!serverConfig.command) {
        throw new Error(`stdio server "${serverName}" requires command`);
      }

      const processedArgs = serverConfig.args?.map(substituteEnvVars);

      servers[serverName] = {
        type: "stdio",
        command: serverConfig.command,
        args: processedArgs,
        env: {
          // Include full environment so MCP server can find commands like npx
          ...process.env as Record<string, string>,
          // Override with specific database URL
          DATABASE_URL: env.DB_TOOL_CONNECTION_URL || env.DATABASE_URL,
        },
      };
    } else if (serverConfig.type === "sse") {
      if (!serverConfig.endpoint) {
        throw new Error(`sse server "${serverName}" requires endpoint`);
      }

      servers[serverName] = {
        type: "sse",
        url: substituteEnvVars(serverConfig.endpoint),
      };
    } else {
      throw new Error(`Unsupported MCP transport type: ${serverConfig.type}`);
    }

    // Store tool tier mappings
    if (serverConfig.tools) {
      for (const tool of serverConfig.tools) {
        const mappedName = tool.mapped_name || tool.name;
        toolTiers.set(mappedName, {
          tier: tool.tier,
          serverName,
          originalName: tool.name,
          guardrails: tool.guardrails,
        });
      }
    }
  }

  return { servers, toolTiers };
}

/**
 * Get tool tier by mapped name
 */
export function getToolTier(
  toolTiers: Map<string, { tier: 1 | 2 | 3; serverName: string; originalName: string; guardrails?: string }>,
  toolName: string
): 1 | 2 | 3 {
  const tool = toolTiers.get(toolName);
  return tool?.tier ?? 1; // Default to tier 1 (auto-approve) if not configured
}

/**
 * Get tool info by mapped name
 */
export function getToolInfo(
  toolTiers: Map<string, { tier: 1 | 2 | 3; serverName: string; originalName: string; guardrails?: string }>,
  toolName: string
): { tier: 1 | 2 | 3; serverName: string; originalName: string; guardrails?: string } | undefined {
  return toolTiers.get(toolName);
}