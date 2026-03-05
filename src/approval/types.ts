export interface ApprovalRequest {
  id: string;
  taskId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier: 1 | 2 | 3;
  requestedBy: string;
  approvedBy: string | null;
  status: "pending" | "approved" | "rejected" | "timeout";
  guardrailOutput: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export type ApprovalDecision = "approved" | "rejected" | "timeout";
