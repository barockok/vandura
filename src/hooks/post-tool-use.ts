/**
 * PostToolUse Hook - Audit logging for all tool executions
 *
 * This hook emits an audit event for every tool execution after it completes,
 * capturing input, output, and approval information for compliance and debugging.
 */

import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { auditEmitter } from "../audit/emitter.js";

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

  auditEmitter.emit("tool_use", {
    sessionId,
    toolName,
    toolInput,
    toolOutput: toolResult,
    toolUseId: toolUseId || "",
    timestamp: new Date(),
  });

  console.log(`[PostToolUse] Logged ${toolName}`);

  return {};
};
