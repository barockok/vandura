/**
 * PreToolUse Hook - Maker-Checker approval flow
 *
 * Checks tool tier from tool-policies.yml:
 * - Tier 1: Auto-allow (pass through)
 * - Tier 2/3: Check for resolved approval in DB.
 *   If approved → allow. If denied → deny.
 *   If no approval exists → store pending, post to Slack, deny.
 */

import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getToolTier, storePendingApproval, getResolvedApproval } from "../agent/permissions.js";
import { postApprovalToSlack } from "./approval-notifier.js";

export const preToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const preInput = input as PreToolUseHookInput;
  const sessionId = preInput.session_id;
  const toolName = preInput.tool_name;
  const toolInput = (preInput as unknown as { tool_input: Record<string, unknown> }).tool_input ?? {};

  console.log(`[PreToolUse] Tool: ${toolName}, Session: ${sessionId}`);

  const tier = getToolTier(toolName);

  // Tier 1: auto-allow
  if (tier === 1) {
    console.log(`[PreToolUse] Tier 1 auto-allow: ${toolName}`);
    return {};
  }

  // Tier 2/3: check for existing resolved approval
  const resolved = await getResolvedApproval(sessionId, toolName);

  if (resolved) {
    if (resolved.decision === "allow") {
      console.log(`[PreToolUse] Found approved approval for ${toolName}, allowing`);
      return {};
    }
    console.log(`[PreToolUse] Found denied approval for ${toolName}, denying`);
    return {
      permissionDecision: "deny",
      reason: `Tool "${toolName}" was denied by approver.`,
    };
  }

  // No resolved approval — store pending and notify Slack
  console.log(`[PreToolUse] Tier ${tier} — requesting approval for ${toolName}`);

  const approval = await storePendingApproval({
    sessionId,
    toolName,
    toolInput,
    toolUseId: toolUseId ?? "",
    tier: tier as 1 | 2 | 3,
  });

  await postApprovalToSlack(sessionId, approval);

  return {
    permissionDecision: "deny",
    reason: `Awaiting ${tier === 2 ? "initiator" : "checker"} approval for tool "${toolName}". Reply \`approve\` or \`deny\` in the thread to continue.`,
  };
};
