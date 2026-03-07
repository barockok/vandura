import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpConfig, McpServerConfig, DiscoveredTool } from "./types.js";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { env } from "../config/env.js";

export class McpManager {
  private clients: Map<string, Client> = new Map();
  private discoveredTools: DiscoveredTool[] = [];
  private config: McpConfig | null = null;

  async load(configPath: string): Promise<void> {
    const content = await readFile(configPath, "utf-8");
    this.config = parseYaml(content) as McpConfig;

    // Replace environment variable placeholders
    this.config = this.substituteEnvVars(this.config);

    // Connect to each MCP server
    for (const [serverName, serverConfig] of Object.entries(this.config.servers)) {
      try {
        await this.connectServer(serverName, serverConfig);
      } catch (err) {
        console.error(`[MCP] Failed to connect to server "${serverName}":`, err);
      }
    }
  }

  private substituteEnvVars(config: McpConfig): McpConfig {
    const json = JSON.stringify(config);
    const substituted = json.replace(/\$\{([^}]+)\}/g, (_, key) => {
      const value = (env as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : String(value || "");
    });
    return JSON.parse(substituted) as McpConfig;
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    console.log(`[MCP] Connecting to server: ${name} (${config.type})`);

    let transport: StdioClientTransport | SSEClientTransport;

    if (config.type === "stdio") {
      if (!config.command) {
        throw new Error(`stdio server "${name}" requires command`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
      });
    } else if (config.type === "sse") {
      if (!config.endpoint) {
        throw new Error(`sse server "${name}" requires endpoint`);
      }
      transport = new SSEClientTransport(new URL(config.endpoint));
    } else {
      throw new Error(`Unsupported MCP transport type: ${config.type}`);
    }

    const client = new Client({
      name: "vandura",
      version: "1.0.0",
    });

    await client.connect(transport);
    this.clients.set(name, client);

    // Discover tools from this server
    await this.discoverTools(name, client, config);

    console.log(`[MCP] Connected to server: ${name}`);
  }

  private async discoverTools(serverName: string, client: Client, serverConfig: McpServerConfig): Promise<void> {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      // Find tool config from mcp-servers.yml
      const toolConfig = serverConfig.tools?.find(
        (t) => t.name === tool.name || t.mapped_name === tool.name
      );

      if (!toolConfig) {
        console.warn(`[MCP] Tool "${tool.name}" from server "${serverName}" not in config, skipping`);
        continue;
      }

      const mappedName = toolConfig.mapped_name || tool.name;

      this.discoveredTools.push({
        serverName,
        originalName: tool.name,
        mappedName,
        tier: toolConfig.tier,
        guardrails: toolConfig.guardrails,
        definition: {
          name: mappedName,
          description: tool.description || "",
          input_schema: tool.inputSchema as Record<string, unknown>,
        },
      });
    }
  }

  getDiscoveredTools(): DiscoveredTool[] {
    return [...this.discoveredTools];
  }

  getClient(serverName: string): Client | undefined {
    return this.clients.get(serverName);
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<{ content: unknown }> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    // Find original tool name from mapped name
    const tool = this.discoveredTools.find(
      (t) => t.mappedName === toolName && t.serverName === serverName
    );

    if (!tool) {
      throw new Error(`Tool "${toolName}" not found on server "${serverName}"`);
    }

    const result = await client.callTool({
      name: tool.originalName,
      arguments: args,
    });

    return { content: result.content };
  }

  async shutdown(): Promise<void> {
    console.log("[MCP] Shutting down all servers...");
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.close();
        console.log(`[MCP] Disconnected from server: ${name}`);
      } catch (err) {
        console.error(`[MCP] Error closing server "${name}":`, err);
      }
    }
    this.clients.clear();
    this.discoveredTools = [];
  }
}
