/**
 * PreToolUse Hook - Audit tracking for tool executions
 *
 * This hook tracks tool calls for audit purposes. The actual approval logic
 * is handled by the canUseTool callback in sdk-runtime.ts which supports
 * pause/resume with interrupt:true.
 */

import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * PreToolUse hook callback - allows all tools, tracking is done in PostToolUse
 */
export const preToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const preInput = input as PreToolUseHookInput;
  const sessionId = preInput.session_id;
  const toolName = preInput.tool_name;

  console.log(`[PreToolUse] Tool called: ${toolName}, Session: ${sessionId}`);

  // Allow all tools - approval logic is in canUseTool callback
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
};
