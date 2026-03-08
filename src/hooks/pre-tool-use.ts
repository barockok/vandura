/**
 * PreToolUse Hook - Tier-based approval routing for make-checker pattern
 *
 * This hook intercepts tool calls before execution and enforces the tier-based
 * approval system:
 * - Tier 1: Auto-approve (read-only tools)
 * - Tier 2: Ask initiator for approval
 * - Tier 3: Ask checker (someone other than initiator) for approval
 */

import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getToolTier, storePendingApproval } from "../agent/permissions.js";
import { pool } from "../db/pool.js";

// Cache for pending approvals to correlate Pre/Post hooks
const pendingApprovalsCache = new Map<string, { approvalId: string; tier: number }>();

/**
 * PreToolUse hook callback
 *
 * @param input - Hook input data containing tool details
 * @param toolUseId - Unique identifier for this tool use
 * @param context - Context object for sharing data between hooks
 * @returns Permission decision to allow, deny, or ask for approval
 */
export const preToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const preInput = input as PreToolUseHookInput;
  const sessionId = preInput.session_id;
  const toolName = preInput.tool_name;
  const toolInput = preInput.tool_input as Record<string, unknown>;

  console.log(`[PreToolUse] Tool: ${toolName}, Session: ${sessionId}`);

  try {
    // Get tool tier from policy
    const tier = getToolTier(toolName);

    // Tier 1: Auto-approve without interruption
    if (tier === 1) {
      console.log(`[PreToolUse] Auto-approving tier 1 tool: ${toolName}`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      };
    }

    // Tier 2/3: Request approval and interrupt
    console.log(`[PreToolUse] Requesting approval for tier ${tier} tool: ${toolName}`);

    // Store pending approval in database
    const approval = await storePendingApproval({
      sessionId,
      toolName,
      toolInput,
      toolUseId: toolUseId!,
      tier,
    });

    // Cache approval info for PostToolUse hook correlation
    if (toolUseId) {
      pendingApprovalsCache.set(toolUseId, {
        approvalId: approval.id,
        tier,
      });
    }

    // Get session info to determine who should approve
    const sessionResult = await pool.query<{
      initiator_slack_id: string;
      checker_slack_id: string | null;
    }>(
      "SELECT initiator_slack_id, checker_slack_id FROM sessions WHERE id = $1",
      [sessionId]
    );

    const session = sessionResult.rows[0];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Determine approver based on tier
    const approverInfo = tier === 2
      ? `initiator (<@${session.initiator_slack_id}>)`
      : session.checker_slack_id
        ? `checker (<@${session.checker_slack_id}>)`
        : "a checker (not yet assigned)";

    console.log(`[PreToolUse] Approval ${approval.id} created, waiting for ${approverInfo}`);

    // Return ask decision with interrupt to pause execution
    return {
      systemMessage: `⚠️ **Approval Required (Tier ${tier})**\n\n**Tool:** \`${toolName}\`\n**Approver:** ${approverInfo}\n\nType \`approve\` or \`deny\` in this thread to respond.`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: `Tier ${tier} approval required. Waiting for ${tier === 2 ? "initiator" : "checker"} approval.`,
      },
    };
  } catch (error) {
    console.error("[PreToolUse] Error processing tool:", error);

    // On error, deny the tool to be safe
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Error processing approval: ${error instanceof Error ? error.message : "Unknown error"}`,
      },
    };
  }
};

/**
 * Clear cache entry for a tool use (called after PostToolUse)
 */
export function clearPendingApprovalCache(toolUseId: string): void {
  pendingApprovalsCache.delete(toolUseId);
}

/**
 * Get pending approval info for a tool use
 */
export function getPendingApprovalInfo(toolUseId: string): { approvalId: string; tier: number } | undefined {
  return pendingApprovalsCache.get(toolUseId);
}
