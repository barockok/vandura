interface SummaryParams {
  taskId: string;
  status: "completed" | "cancelled";
  messageCount: number;
  toolCallCount: number;
  approvalCount: number;
  duration: string;
  inputTokens: number;
  outputTokens: number;
}

export class TaskLifecycle {
  parseCommand(text: string): "completed" | "cancelled" | null {
    const normalized = text.trim().toLowerCase();
    if (["done", "close", "task complete", "finish", "complete"].includes(normalized)) {
      return "completed";
    }
    if (["cancel", "abort", "stop"].includes(normalized)) {
      return "cancelled";
    }
    return null;
  }

  buildSummary(params: SummaryParams): string {
    const icon = params.status === "completed" ? "\u2705" : "\uD83D\uDEAB";
    return [
      `${icon} *Task ${params.status}*`,
      ``,
      `\u2022 ${params.messageCount} messages exchanged`,
      `\u2022 ${params.toolCallCount} tool calls executed`,
      `\u2022 ${params.approvalCount} approval(s) processed`,
      `\u2022 Duration: ${params.duration}`,
      `\u2022 Tokens: ${params.inputTokens.toLocaleString()} in / ${params.outputTokens.toLocaleString()} out`,
      ``,
      `_Task ID: ${params.taskId}_`,
    ].join("\n");
  }
}
