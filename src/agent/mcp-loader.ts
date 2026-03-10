import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
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
 * Loaded MCP configuration
 */
export interface LoadedMcpConfig {
  servers: Record<string, SdkMcpServerConfig>;
}

/**
 * Substitute environment variables in a string
 * Supports ${VAR_NAME} syntax
 */
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return process.env[key] ?? "";
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
          DATABASE_URL: process.env.DB_TOOL_CONNECTION_URL || process.env.DATABASE_URL || "",
          // Merge server-specific env vars (with ${VAR} substitution)
          ...Object.fromEntries(
            Object.entries(serverConfig.env ?? {}).map(([k, v]) => [k, substituteEnvVars(v)])
          ),
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
  }

  return { servers };
}