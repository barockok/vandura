/**
 * PostToolUse Hook - Audit logging for all tool executions
 *
 * This hook logs every tool execution to the audit_logs table after it completes,
 * capturing input, output, and approval information for compliance and debugging.
 */

import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { pool } from "../db/pool.js";
import { getPendingApprovalInfo, clearPendingApprovalCache } from "./pre-tool-use.js";

/**
 * PostToolUse hook callback
 *
 * @param input - Hook input data containing tool execution results
 * @param toolUseId - Unique identifier for this tool use (matches PreToolUse)
 * @param context - Context object for sharing data between hooks
 * @returns Empty object to allow normal execution
 */
export const postToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const postInput = input as PostToolUseHookInput;
  const sessionId = postInput.session_id;
  const toolName = postInput.tool_name;
  const toolInput = postInput.tool_input as Record<string, unknown>;
  const toolResult = postInput.tool_response as Record<string, unknown>;

  console.log(`[PostToolUse] Logging tool: ${toolName}, Session: ${sessionId}`);

  try {
    // Check if there's a pending approval for this tool use
    const approvalInfo = toolUseId ? getPendingApprovalInfo(toolUseId) : undefined;

    // Determine decision and approver based on tier
    let decision = "allowed";
    let approverId: string | null = null;
    let pendingApprovalId: string | null = null;
    let tier = 1;

    if (approvalInfo) {
      tier = approvalInfo.tier;
      pendingApprovalId = approvalInfo.approvalId;

      // Check if approval was resolved
      const approvalResult = await pool.query<{
        decision: string | null;
        approver_id: string | null;
      }>(
        "SELECT decision, approver_id FROM pending_approvals WHERE id = $1",
        [approvalInfo.approvalId]
      );

      if (approvalResult.rows.length > 0) {
        const row = approvalResult.rows[0];
        if (row.decision === "allow") {
          decision = "approved";
          approverId = row.approver_id;
        } else if (row.decision === "deny") {
          decision = "denied";
          approverId = row.approver_id;
        }
      }

      // Clear cache entry
      if (toolUseId) {
        clearPendingApprovalCache(toolUseId);
      }
    }

    // Safely stringify tool input/output
    const stringifySafely = (obj: unknown): string => {
      try {
        return JSON.stringify(obj);
      } catch {
        return JSON.stringify({ error: "Could not stringify" });
      }
    };

    // Insert audit log entry
    await pool.query(
      `INSERT INTO audit_logs (
        session_id, tool_name, tool_input, tool_output, tool_use_id,
        tier, decision, approver_id, pending_approval_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT DO NOTHING`,
      [
        sessionId,
        toolName,
        stringifySafely(toolInput),
        stringifySafely(toolResult),
        toolUseId || null,
        tier,
        decision,
        approverId,
        pendingApprovalId,
      ]
    );

    console.log(`[PostToolUse] Logged ${toolName} with decision: ${decision}`);

    return {};
  } catch (error) {
    console.error("[PostToolUse] Error logging tool execution:", error);

    // Don't block execution on logging errors
    return {};
  }
};
