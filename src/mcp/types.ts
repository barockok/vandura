export interface McpServerConfig {
  name: string;
  type: "stdio" | "sse" | "websocket";
  command?: string;
  args?: string[];
  endpoint?: string;
  auth?: "none" | "oauth" | "api-key";
  tools?: McpToolConfig[];
}

export interface McpToolConfig {
  name: string;
  tier: 1 | 2 | 3;
  guardrails?: string;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface DiscoveredTool {
  serverName: string;
  originalName: string;
  tier: 1 | 2 | 3;
  guardrails?: string;
  definition: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
}
