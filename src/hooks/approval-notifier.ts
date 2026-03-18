/**
 * Approval Notifier - Posts approval requests to Slack from hooks
 *
 * Factory creates a notifier function that posts directly to a given
 * channel/thread, removing the need for DB lookups.
 */

/**
 * Approval info needed to post the Slack message
 */
export interface ApprovalInfo {
  toolName: string;
  tier: number;
  toolInput: Record<string, unknown>;
}

/**
 * Type for the notifier function returned by createApprovalNotifier
 */
export type ApprovalNotifier = (
  channelId: string,
  threadTs: string,
  approval: ApprovalInfo,
) => Promise<void>;

/**
 * Create an approval notifier that posts approval requests to Slack.
 * Uses fetch to call the Slack API directly (hooks don't have access to Bolt).
 */
export function createApprovalNotifier(slackBotToken: string): ApprovalNotifier {
  return async function postApprovalToSlack(
    channelId: string,
    threadTs: string,
    approval: ApprovalInfo,
  ): Promise<void> {
    if (!channelId || !threadTs) {
      console.warn(`[ApprovalNotifier] Missing channelId or threadTs, skipping Slack notification`);
      return;
    }

    const tierEmoji = approval.tier === 2 ? "\u26A0\uFE0F" : "\uD83D\uDD34";
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
          "Authorization": `Bearer ${slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: channelId,
          text: message,
          thread_ts: threadTs,
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
  };
}
