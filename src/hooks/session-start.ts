/**
 * SessionStart Hook - Initialize session tracking
 *
 * This hook fires when a new session starts, allowing us to log session
 * initialization and set up any necessary context.
 */

import type { HookCallback, SessionStartHookInput } from "@anthropic-ai/claude-agent-sdk";
import { pool } from "../db/pool.js";

/**
 * SessionStart hook callback
 *
 * @param input - Hook input data containing session details
 * @param toolUseId - Undefined for SessionStart hooks
 * @param context - Context object for sharing data between hooks
 * @returns Empty object to allow normal execution
 */
export const sessionStartHook: HookCallback = async (input, toolUseId, context) => {
  const sessionInput = input as SessionStartHookInput;
  const sessionId = sessionInput.session_id;

  console.log(`[SessionStart] Session initialized: ${sessionId}`);

  try {
    // Log session start to audit_log table (existing table for high-level events)
    await pool.query(
      `INSERT INTO audit_log (action, actor, detail)
       VALUES ($1, $2, $3)`,
      [
        "session_started",
        "system",
        JSON.stringify({ sessionId, timestamp: new Date().toISOString() }),
      ]
    );

    return {};
  } catch (error) {
    console.error("[SessionStart] Error logging session start:", error);

    // Don't block execution on logging errors
    return {};
  }
};
