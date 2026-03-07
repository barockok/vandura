// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (message: any) => Promise<unknown>;

interface ApprovalRequestParams {
  say: SayFn;
  threadTs: string;
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier: 2 | 3;
  initiatorSlackId: string;
  checkerSlackId: string | null;
}

interface CanApproveParams {
  tier: 2 | 3;
  userId: string;
  initiatorSlackId: string;
  checkerSlackId: string | null;
}

export const APPROVAL_ACTION_APPROVE = "approval_approve";
export const APPROVAL_ACTION_REJECT = "approval_reject";

export class SlackApprovalFlow {
  async postApprovalRequest(params: ApprovalRequestParams): Promise<void> {
    const approverMention =
      params.tier === 2
        ? `<@${params.initiatorSlackId}>`
        : params.checkerSlackId
          ? `<@${params.checkerSlackId}>`
          : "A checker";

    const inputSummary = JSON.stringify(params.toolInput, null, 2);
    const truncatedInput =
      inputSummary.length > 500
        ? inputSummary.slice(0, 500) + "..."
        : inputSummary;

    const fallbackText = `⚠️ Approval Required (Tier ${params.tier}) — Tool: ${params.toolName}`;

    await params.say({
      text: fallbackText,
      thread_ts: params.threadTs,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `⚠️ *Approval Required (Tier ${params.tier})*`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Tool:*\n\`${params.toolName}\`` },
            { type: "mrkdwn", text: `*Approver:*\n${approverMention}` },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Input:*\n\`\`\`${truncatedInput}\`\`\``,
          },
        },
        {
          type: "actions",
          block_id: `approval_${params.approvalId}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "✅ Approve" },
              style: "primary",
              action_id: APPROVAL_ACTION_APPROVE,
              value: params.approvalId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "❌ Reject" },
              style: "danger",
              action_id: APPROVAL_ACTION_REJECT,
              value: params.approvalId,
            },
          ],
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `Approval ID: \`${params.approvalId}\`` },
          ],
        },
      ],
    });
  }

  parseDecision(text: string): "approved" | "rejected" | null {
    const normalized = text.trim().toLowerCase();
    if (["approve", "approved", "yes", "lgtm", "ok"].includes(normalized)) {
      return "approved";
    }
    if (["deny", "denied", "reject", "rejected", "no"].includes(normalized)) {
      return "rejected";
    }
    return null;
  }

  canApprove(params: CanApproveParams): boolean {
    if (params.tier === 2) {
      return params.userId === params.initiatorSlackId;
    }
    // Tier 3: must be checker, cannot be initiator
    if (params.userId === params.initiatorSlackId) return false;
    if (params.checkerSlackId) {
      return params.userId === params.checkerSlackId;
    }
    // If no checker assigned, any non-initiator can approve
    return true;
  }
}
