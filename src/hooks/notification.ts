/**
 * Notification Hook - Forward agent status to Slack
 *
 * This hook receives notifications from the agent about various events
 * (permission prompts, idle states, etc.) and can forward them to Slack.
 */

import type { HookCallback, NotificationHookInput } from "@anthropic-ai/claude-agent-sdk";

/**
 * Notification hook callback
 *
 * @param input - Hook input data containing notification message
 * @param toolUseId - Undefined for Notification hooks
 * @param context - Context object for sharing data between hooks
 * @returns Empty object as notifications don't modify agent behavior
 */
export const notificationHook: HookCallback = async (input, toolUseId, context) => {
  const notification = input as NotificationHookInput;
  const message = notification.message;
  const title = notification.title;
  const notificationType = notification.notification_type;

  // Log notifications for debugging
  console.log(`[Notification] ${notificationType}: ${message}${title ? ` (${title})` : ''}`);

  // Note: For actual Slack forwarding, we would need access to the
  // session's channel information. This would require:
  // 1. Storing session -> channel mapping in SessionStart hook
  // 2. Injecting Slack client into hooks
  //
  // For now, we log notifications. Slack messages are sent via
  // the application's existing message callbacks.

  return {};
};
