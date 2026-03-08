import type { App } from "@slack/bolt";

/**
 * Slack responder for sending messages from workers
 */
export interface SlackResponder {
  postMessage: (channelId: string, message: string, threadTs?: string) => Promise<void>;
  postApprovalRequest: (
    channelId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    tier: number,
    threadTs?: string
  ) => Promise<void>;
}

/**
 * Create a Slack responder from a Bolt app
 */
export function createSlackResponder(app: App): SlackResponder {
  return {
    async postMessage(channelId: string, message: string, threadTs?: string): Promise<void> {
      try {
        await app.client.chat.postMessage({
          channel: channelId,
          text: message,
          thread_ts: threadTs,
          mrkdwn: true,
        });
      } catch (error) {
        console.error(`[SlackResponder] Failed to post message:`, error);
        throw error;
      }
    },

    async postApprovalRequest(
      channelId: string,
      toolName: string,
      toolInput: Record<string, unknown>,
      tier: number,
      threadTs?: string
    ): Promise<void> {
      const tierEmoji = tier === 2 ? "⚠️" : "🔴";
      const tierLabel = tier === 2 ? "Initiator Approval" : "Checker Approval Required";

      const inputSummary = JSON.stringify(toolInput, null, 2);
      const truncatedInput = inputSummary.length > 500
        ? inputSummary.slice(0, 500) + "..."
        : inputSummary;

      const message = `${tierEmoji} *${tierLabel}*

Tool: \`${toolName}\`
Input:
\`\`\`
${truncatedInput}
\`\`\`

Reply with \`approve\` or \`deny\` to continue.`;

      try {
        await app.client.chat.postMessage({
          channel: channelId,
          text: message,
          thread_ts: threadTs,
          mrkdwn: true,
        });
      } catch (error) {
        console.error(`[SlackResponder] Failed to post approval request:`, error);
        throw error;
      }
    },
  };
}