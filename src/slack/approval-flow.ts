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

export class SlackApprovalFlow {
  async postApprovalRequest(params: ApprovalRequestParams): Promise<void> {
    const approverMention =
      params.tier === 2
        ? `<@${params.initiatorSlackId}>`
        : params.checkerSlackId
          ? `<@${params.checkerSlackId}>`
          : "a checker";

    const inputSummary = JSON.stringify(params.toolInput, null, 2);
    const truncatedInput =
      inputSummary.length > 500
        ? inputSummary.slice(0, 500) + "..."
        : inputSummary;

    const text = [
      `⚠️ *Approval Required (Tier ${params.tier})*`,
      ``,
      `Tool: \`${params.toolName}\``,
      `Input:`,
      `\`\`\`${truncatedInput}\`\`\``,
      ``,
      `${approverMention}, please reply with *approve* or *deny*.`,
      `_(approval id: ${params.approvalId})_`,
    ].join("\n");

    await params.say({ text, thread_ts: params.threadTs });
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
