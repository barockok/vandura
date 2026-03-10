export interface McpServerConfig {
  name: string;
  type: "stdio" | "sse" | "websocket";
  command?: string;
  args?: string[];
  endpoint?: string;
  auth?: "none" | "oauth" | "api-key";
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}
