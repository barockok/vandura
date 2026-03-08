/**
 * PreToolUse Hook - Audit tracking for tool executions
 *
 * This hook tracks tool calls for audit purposes. The actual approval logic
 * is handled by the canUseTool callback in sdk-runtime.ts which supports
 * pause/resume with interrupt:true.
 *
 * IMPORTANT: Return {} to pass through - do NOT return permissionDecision
 * as it conflicts with canUseTool callback
 */

import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * PreToolUse hook callback - pass through to canUseTool for approval logic
 */
export const preToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const preInput = input as PreToolUseHookInput;
  const sessionId = preInput.session_id;
  const toolName = preInput.tool_name;

  console.log(`[PreToolUse] Tool called: ${toolName}, Session: ${sessionId}`);

  // Return empty object to pass through - approval logic is in canUseTool callback
  // Returning permissionDecision here would conflict with canUseTool
  return {};
};
