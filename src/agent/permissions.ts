import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

/**
 * Tool policy from tool-policies.yml
 */
interface ToolPolicy {
  tier: 1 | 2 | 3;
  connection_type: "shared" | "per-user";
  guardrails?: string;
}

interface ToolPoliciesConfig {
  tool_policies: Record<string, ToolPolicy>;
}

/**
 * Loaded tool policies
 */
let toolPolicies: Map<string, ToolPolicy> | null = null;

/**
 * Load tool policies from YAML file
 */
export async function loadToolPolicies(configPath: string): Promise<Map<string, ToolPolicy>> {
  if (toolPolicies) {
    return toolPolicies;
  }

  const content = await readFile(configPath, "utf-8");
  const config = parseYaml(content) as ToolPoliciesConfig;

  toolPolicies = new Map();

  for (const [toolName, policy] of Object.entries(config.tool_policies)) {
    toolPolicies.set(toolName, policy);
  }

  return toolPolicies;
}

/**
 * Get tool policy by name
 */
export function getToolPolicy(toolName: string): ToolPolicy {
  if (!toolPolicies) {
    throw new Error("Tool policies not loaded. Call loadToolPolicies() first.");
  }

  // Check for exact match
  const policy = toolPolicies.get(toolName);
  if (policy) {
    return policy;
  }

  // Check for MCP tool pattern (mcp__server__tool)
  if (toolName.startsWith("mcp__")) {
    const mcpPolicy = toolPolicies.get(toolName);
    if (mcpPolicy) {
      return mcpPolicy;
    }
  }

  // Return default policy
  const defaultPolicy = toolPolicies.get("_default");
  if (defaultPolicy) {
    return defaultPolicy;
  }

  // Fallback to tier 2 if no default configured
  return {
    tier: 2,
    connection_type: "shared",
    guardrails: "Ask for confirmation before proceeding.",
  };
}

/**
 * Get tool tier by name
 */
export function getToolTier(toolName: string): 1 | 2 | 3 {
  const policy = getToolPolicy(toolName);
  console.log(`[getToolTier] Tool: ${toolName}, returning tier: ${policy.tier}`);
  return policy.tier;
}

/**
 * Get all guardrails from loaded tool policies
 */
export function getAllGuardrails(): Record<string, string> {
  if (!toolPolicies) {
    throw new Error("Tool policies not loaded. Call loadToolPolicies() first.");
  }

  const guardrails: Record<string, string> = {};
  for (const [toolName, policy] of toolPolicies.entries()) {
    if (policy.guardrails) {
      guardrails[toolName] = policy.guardrails;
    }
  }
  return guardrails;
}

