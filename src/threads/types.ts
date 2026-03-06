export interface Task {
  id: string;
  slackThreadTs: string;
  slackChannel: string;
  agentId: string;
  initiatorSlackId: string;
  checkerSlackId: string | null;
  topic: string | null;
  status: "open" | "completed" | "cancelled";
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  closedAt: Date | null;
}

export interface Message {
  id: string;
  taskId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}
