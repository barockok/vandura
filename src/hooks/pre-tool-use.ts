/**
 * PreToolUse Hook - Maker-Checker approval flow
 *
 * Checks tool tier from tool-policies.yml:
 * - Tier 1: Auto-allow (pass through)
 * - Tier 2/3: Check for pending approval in SessionStore.
 *   If already pending for same tool → block again.
 *   If no pending → create one and block.
 */

import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getToolTier } from "../agent/permissions.js";
import { containsSensitiveData } from "../tools/memory.js";
import { env } from "../config/env.js";
import type { SessionStore } from "../session/store.js";

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

/**
 * Factory that creates a PreToolUse hook backed by SessionStore.
 */
export function createPreToolUseHook(sessionStore: SessionStore): HookCallback {
  return async (input, toolUseId, _context) => {
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

    // Tier 2/3: check for existing pending approval in SessionStore
    const pending = await sessionStore.getPendingApproval(sessionId);

    if (pending && pending.toolName === toolName) {
      // Already pending for the same tool — block again
      const reason = `Awaiting ${tier === 2 ? "initiator" : "checker"} approval for tool "${toolName}". Reply \`approve\` or \`deny\` in the thread to continue.`;
      console.log(`[PreToolUse] Already pending approval for ${toolName}, blocking`);
      return {
        decision: "block" as const,
        reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: reason,
        },
      };
    }

    // No pending approval — create one
    console.log(`[PreToolUse] Tier ${tier} — requesting approval for ${toolName}`);

    await sessionStore.setPendingApproval(sessionId, "", "", {
      toolName,
      tier: tier as 1 | 2 | 3,
      toolUseId: toolUseId ?? "",
      toolInput,
    });
    // Note: channelId/threadTs are empty strings for now — will be properly wired in Task 6

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
}

/**
 * Legacy preToolUseHook export for backward compatibility.
 * This is a no-op passthrough that auto-allows everything.
 * Will be replaced by createPreToolUseHook() in Task 6 when sdk-runtime.ts is updated.
 */
export const preToolUseHook: HookCallback = async (input, _toolUseId, _context) => {
  const preInput = input as PreToolUseHookInput;
  console.log(`[PreToolUse] Legacy hook (no-op) called for tool: ${preInput.tool_name}`);
  return {};
};
