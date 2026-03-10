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
import { containsSensitiveData } from "../tools/memory.js";
import { env } from "../config/env.js";

/**
 * Check if a tool call is a write to the memory directory
 */
export function isMemoryWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  memoryDir: string,
): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  const filePath = (toolInput.file_path as string) || "";
  const normalizedDir = memoryDir.endsWith("/") ? memoryDir : memoryDir + "/";
  return filePath.startsWith(normalizedDir);
}

/**
 * Check if memory write content contains sensitive data.
 * Returns block reason string if blocked, null if allowed.
 */
export function shouldBlockMemoryWrite(
  toolInput: Record<string, unknown>,
): string | null {
  const content = (toolInput.content as string) || (toolInput.new_string as string) || "";
  if (containsSensitiveData(content)) {
    return "Content appears to contain sensitive data (API keys, tokens, passwords). Please redact before saving to memory.";
  }
  return null;
}

export const preToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const preInput = input as PreToolUseHookInput;
  const sessionId = preInput.session_id;
  const toolName = preInput.tool_name;
  const toolInput = (preInput.tool_input as Record<string, unknown>) ?? {};

  console.log(`[PreToolUse] Tool: ${toolName}, Session: ${sessionId}`);

  // Memory write guard — block sensitive data from being saved
  if (isMemoryWrite(toolName, toolInput, env.VANDURA_MEMORY_DIR)) {
    const blockReason = shouldBlockMemoryWrite(toolInput);
    if (blockReason) {
      console.log(`[PreToolUse] Blocked memory write: sensitive data detected`);
      return {
        decision: "block" as const,
        reason: blockReason,
      };
    }
    // Safe memory write — auto-allow (tier 1)
    return {};
  }

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
      return { decision: "approve" as const };
    }
    console.log(`[PreToolUse] Found denied approval for ${toolName}, denying`);
    return {
      decision: "block" as const,
      reason: `Tool "${toolName}" was denied by approver.`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `Tool "${toolName}" was denied by approver.`,
      },
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

  const reason = `Awaiting ${tier === 2 ? "initiator" : "checker"} approval for tool "${toolName}". Reply \`approve\` or \`deny\` in the thread to continue.`;

  return {
    decision: "block" as const,
    reason,
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: reason,
    },
  };
};
