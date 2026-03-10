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
  /** Server-specific env vars resolved from YAML ${VAR} references.
   *  Must be passed to the SDK's env option so MCP servers inherit them. */
  resolvedEnv: Record<string, string>;
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

      // Only pass server-specific env vars — do NOT dump process.env here.
      // Claude Code merges config env with its process env, but npm lifecycle
      // vars (npm_config_*, npm_lifecycle_*) in a full dump break npx startup.
      const serverEnv: Record<string, string> = {
        DATABASE_URL: process.env.DB_TOOL_CONNECTION_URL || process.env.DATABASE_URL || "",
        ...Object.fromEntries(
          Object.entries(serverConfig.env ?? {}).map(([k, v]) => [k, substituteEnvVars(v)])
        ),
      };

      servers[serverName] = {
        type: "stdio",
        command: serverConfig.command,
        args: processedArgs,
        env: serverEnv,
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

  // Collect server-specific env vars that need to be in the parent process.
  // These get resolved here and must be passed via the SDK's env option.
  const resolvedEnv: Record<string, string> = {
    DATABASE_URL: process.env.DB_TOOL_CONNECTION_URL || process.env.DATABASE_URL || "",
  };
  for (const serverConfig of Object.values(config.servers)) {
    if (serverConfig.env) {
      for (const [k, v] of Object.entries(serverConfig.env)) {
        resolvedEnv[k] = substituteEnvVars(v);
      }
    }
  }

  return { servers, resolvedEnv };
}