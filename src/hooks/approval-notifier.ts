/**
 * Approval Notifier - Posts approval requests to Slack from hooks
 *
 * Hooks don't have access to the Slack Bolt app instance, so we use
 * the Slack Web API directly with the bot token.
 */

import { pool } from "../db/pool.js";
import type { PendingApproval } from "../queue/types.js";

/**
 * Post an approval request message to the Slack thread for a session
 */
export async function postApprovalToSlack(
  sessionId: string,
  approval: PendingApproval
): Promise<void> {
  // Look up session to get channel and thread
  const result = await pool.query<{
    channel_id: string;
    thread_ts: string | null;
  }>(
    `SELECT channel_id, thread_ts FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    console.error(`[ApprovalNotifier] Session ${sessionId} not found`);
    return;
  }

  const { channel_id, thread_ts } = result.rows[0];
  const botToken = process.env.SLACK_BOT_TOKEN;

  if (!botToken) {
    console.error(`[ApprovalNotifier] SLACK_BOT_TOKEN not set`);
    return;
  }

  const tierEmoji = approval.tier === 2 ? "⚠️" : "🔴";
  const tierLabel = approval.tier === 2 ? "Initiator Approval" : "Checker Approval Required";

  const inputSummary = JSON.stringify(approval.toolInput, null, 2);
  const truncatedInput = inputSummary.length > 500
    ? inputSummary.slice(0, 500) + "..."
    : inputSummary;

  const message = `${tierEmoji} *${tierLabel}*\n\nTool: \`${approval.toolName}\`\nInput:\n\`\`\`\n${truncatedInput}\n\`\`\`\n\nReply with \`approve\` or \`deny\` to continue.`;

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channel_id,
        text: message,
        thread_ts: thread_ts ?? undefined,
        mrkdwn: true,
      }),
    });

    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      console.error(`[ApprovalNotifier] Slack API error: ${data.error}`);
    }
  } catch (error) {
    console.error(`[ApprovalNotifier] Failed to post approval request:`, error);
  }
}
