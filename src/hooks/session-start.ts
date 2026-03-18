/**
 * SessionStart Hook - Initialize session tracking
 *
 * Emits a session_start audit event when a new session begins.
 */

import type { HookCallback, SessionStartHookInput } from "@anthropic-ai/claude-agent-sdk";
import { auditEmitter } from "../audit/emitter.js";

export const sessionStartHook: HookCallback = async (input, toolUseId, context) => {
  const sessionInput = input as SessionStartHookInput;
  const sessionId = sessionInput.session_id;

  console.log(`[SessionStart] Session initialized: ${sessionId}`);

  auditEmitter.emit("session_start", {
    sessionId,
    channelId: "",
    userId: "",
    timestamp: new Date(),
  });

  return {};
};
