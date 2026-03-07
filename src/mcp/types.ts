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
  mapped_name?: string;  // Optional alias for backward compatibility
  tier: 1 | 2 | 3;
  guardrails?: string;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface DiscoveredTool {
  serverName: string;
  originalName: string;
  mappedName: string;
  tier: 1 | 2 | 3;
  guardrails?: string;
  definition: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
}
