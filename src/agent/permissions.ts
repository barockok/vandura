import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { pool } from "../db/pool.js";
import type { PendingApproval } from "../queue/types.js";

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
 * Store a pending approval request in the database
 */
export async function storePendingApproval(params: {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  tier: 1 | 2 | 3;
}): Promise<PendingApproval> {
  const id = crypto.randomUUID();

  const result = await pool.query<{
    id: string;
    session_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    tier: number;
    requested_at: Date;
    resolved_at: Date | null;
    decision: string | null;
    approver_id: string | null;
  }>(
    `INSERT INTO pending_approvals (id, session_id, tool_name, tool_input, tool_use_id, tier)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, params.sessionId, params.toolName, JSON.stringify(params.toolInput), params.toolUseId, params.tier]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolUseId: row.tool_use_id,
    tier: row.tier,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    decision: row.decision as "allow" | "deny" | null,
    approverId: row.approver_id,
  };
}

/**
 * Get pending approval by session ID
 */
export async function getPendingApproval(sessionId: string): Promise<PendingApproval | null> {
  const result = await pool.query<{
    id: string;
    session_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    tier: number;
    requested_at: Date;
    resolved_at: Date | null;
    decision: string | null;
    approver_id: string | null;
  }>(
    `SELECT * FROM pending_approvals
     WHERE session_id = $1 AND resolved_at IS NULL
     ORDER BY requested_at DESC
     LIMIT 1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolUseId: row.tool_use_id,
    tier: row.tier,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    decision: row.decision as "allow" | "deny" | null,
    approverId: row.approver_id,
  };
}

/**
 * Get a resolved approval for a session and tool name.
 * Used by PreToolUse hook to check if a tool was already approved/denied.
 */
export async function getResolvedApproval(
  sessionId: string,
  toolName: string
): Promise<PendingApproval | null> {
  const result = await pool.query<{
    id: string;
    session_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    tier: number;
    requested_at: Date;
    resolved_at: Date | null;
    decision: string | null;
    approver_id: string | null;
  }>(
    `SELECT * FROM pending_approvals
     WHERE session_id = $1 AND tool_name = $2 AND resolved_at IS NOT NULL
     ORDER BY resolved_at DESC
     LIMIT 1`,
    [sessionId, toolName]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolUseId: row.tool_use_id,
    tier: row.tier,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    decision: row.decision as "allow" | "deny" | null,
    approverId: row.approver_id,
  };
}

/**
 * Resolve a pending approval
 */
export async function resolvePendingApproval(
  sessionId: string,
  decision: "allow" | "deny",
  approverId: string
): Promise<void> {
  await pool.query(
    `UPDATE pending_approvals
     SET resolved_at = NOW(), decision = $1, approver_id = $2
     WHERE session_id = $3 AND resolved_at IS NULL`,
    [decision, approverId, sessionId]
  );
}

