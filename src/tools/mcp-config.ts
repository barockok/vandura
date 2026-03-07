import type { ToolResult } from "./types.js";

export interface McpConfigToolInput {
  action: "add_server" | "set_guardrail" | "list_servers" | "remove_server";
  server_name?: string;
  provider?: string;
  endpoint?: string;
  connection_type?: "shared" | "per-user";
  guardrail?: string;
  tool_name?: string;
}

export class McpConfigTool {
  constructor(
    private configDir: string,
  ) {}

  async execute(input: McpConfigToolInput): Promise<ToolResult> {
    switch (input.action) {
      case "add_server":
        return this.addServer(input);
      case "set_guardrail":
        return this.setGuardrail(input);
      case "list_servers":
        return this.listServers();
      case "remove_server":
        return this.removeServer(input);
      default:
        return {
          output: `Unknown action: ${input.action}. Valid actions: add_server, set_guardrail, list_servers, remove_server`,
          isError: true,
        };
    }
  }

  private addServer(input: McpConfigToolInput): ToolResult {
    if (!input.server_name || !input.provider || !input.endpoint) {
      return {
        output: "Missing required fields. For add_server, provide: server_name, provider, endpoint, connection_type",
        isError: true,
      };
    }

    const config = {
      name: input.server_name,
      provider: input.provider,
      endpoint: input.endpoint,
      connection_type: input.connection_type || "shared",
    };

    return {
      output: `MCP server configuration generated:\n\n\`\`\`yaml\n# Add to config/tool-policies.yml\nmcp__${config.provider}__*:\n  tier: 2\n  connection_type: ${config.connection_type}\n  guardrails: |\n    Confirm action parameters before executing.\n\`\`\`\n\nApply this configuration manually and restart the service.`,
      isError: false,
    };
  }

  private setGuardrail(input: McpConfigToolInput): ToolResult {
    if (!input.tool_name || !input.guardrail) {
      return {
        output: "Missing required fields. For set_guardrail, provide: tool_name, guardrail",
        isError: true,
      };
    }

    return {
      output: `Guardrail configuration generated:\n\n\`\`\`yaml\n# Add to config/tool-policies.yml under ${input.tool_name}:\n  guardrails: |\n    ${input.guardrail}\n\`\`\`\n\nApply this configuration manually and restart the service.`,
      isError: false,
    };
  }

  private listServers(): ToolResult {
    return {
      output: `To list configured MCP servers, check config/tool-policies.yml for connection_type settings.\n\n**Shared connections**: database, Grafana, Elastic, GCS\n**Per-user connections**: Confluence, Google Docs, Jira`,
      isError: false,
    };
  }

  private removeServer(input: McpConfigToolInput): ToolResult {
    if (!input.server_name) {
      return {
        output: "Missing required field: server_name",
        isError: true,
      };
    }

    return {
      output: `To remove MCP server "${input.server_name}":\n\n1. Edit config/tool-policies.yml\n2. Remove entries for mcp__${input.server_name}__*\n3. Restart the service\n\nThis is a config-as-code approach - manual review ensures no accidental removals.`,
      isError: false,
    };
  }

  definition() {
    return {
      name: "mcp_config",
      description: "Configure MCP servers and guardrails. Actions: add_server, set_guardrail, list_servers, remove_server",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add_server", "set_guardrail", "list_servers", "remove_server"],
            description: "The configuration action to perform",
          },
          server_name: {
            type: "string",
            description: "Name of the MCP server (for add_server, remove_server)",
          },
          provider: {
            type: "string",
            description: "Provider name (e.g., confluence, gdocs, db)",
          },
          endpoint: {
            type: "string",
            description: "API endpoint URL for the MCP server",
          },
          connection_type: {
            type: "string",
            enum: ["shared", "per-user"],
            description: "Type of connection",
          },
          tool_name: {
            type: "string",
            description: "Tool name to set guardrail for",
          },
          guardrail: {
            type: "string",
            description: "Guardrail text describing allowed behavior",
          },
        },
        required: ["action"],
      },
    };
  }
}
