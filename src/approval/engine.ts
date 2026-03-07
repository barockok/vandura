import type { Pool } from "../db/connection.js";
import type { ToolPolicies } from "../config/types.js";
import type { ApprovalRequest, ApprovalDecision } from "./types.js";

export interface ClassificationResult {
  tier: 1 | 2 | 3;
  requiresApproval: boolean;
  approver: "none" | "initiator" | "checker";
  guardrails: string | null;
  connectionType: "shared" | "per-user";
}

export interface SharedConnectionGuardrails {
  noFullTableScans: boolean;
  requireIndexedQueries: boolean;
  limitResultSets: boolean;
  uploadLargeResultsToGcs: boolean;
  conserveTokenUsage: boolean;
}

export class ApprovalEngine {
  constructor(
    private pool: Pool,
    private policies: ToolPolicies,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  classify(toolName: string, _toolInput: Record<string, unknown>): ClassificationResult {
    const policy = this.policies[toolName] ?? this.policies["_default"];

    if (!policy) {
      return {
        tier: 3,
        requiresApproval: true,
        approver: "checker",
        guardrails: null,
        connectionType: "shared",
      };
    }

    const tier = typeof policy.tier === "number" ? policy.tier : 3;
    const connectionType = policy.connection_type ?? "shared";

    switch (tier) {
      case 1:
        return {
          tier: 1,
          requiresApproval: false,
          approver: "none",
          guardrails: policy.guardrails ?? null,
          connectionType,
        };
      case 2:
        return {
          tier: 2,
          requiresApproval: true,
          approver: "initiator",
          guardrails: policy.guardrails ?? null,
          connectionType,
        };
      case 3:
      default:
        return {
          tier: 3,
          requiresApproval: true,
          approver: "checker",
          guardrails: policy.guardrails ?? null,
          connectionType,
        };
    }
  }

  getSharedConnectionGuardrails(toolName: string): SharedConnectionGuardrails | null {
    const classification = this.classify(toolName, {});
    if (classification.connectionType !== "shared") {
      return null;
    }
    const guardrails = classification.guardrails ?? "";
    return {
      noFullTableScans: guardrails.includes("full table scan") || guardrails.includes("full scan"),
      requireIndexedQueries: guardrails.includes("indexed"),
      limitResultSets: guardrails.includes("LIMIT") || guardrails.includes("limit") || guardrails.includes("summarize"),
      uploadLargeResultsToGcs: guardrails.includes("GCS") || guardrails.includes("upload"),
      conserveTokenUsage: guardrails.includes("token") || guardrails.includes("conservative"),
    };
  }

  classifyDynamic(
    toolName: string,
    metrics: { estimatedRows: number; hasSeqScan: boolean },
  ): ClassificationResult {
    const policy = this.policies[toolName] ?? this.policies["_default"];
    const guardrails = policy?.guardrails ?? null;
    const connectionType = policy?.connection_type ?? "shared";

    if (metrics.estimatedRows > 50_000 || (metrics.estimatedRows > 10_000 && metrics.hasSeqScan)) {
      return { tier: 3, requiresApproval: true, approver: "checker", guardrails, connectionType };
    }
    if (metrics.estimatedRows > 1000 || metrics.hasSeqScan) {
      return { tier: 2, requiresApproval: true, approver: "initiator", guardrails, connectionType };
    }
    return { tier: 1, requiresApproval: false, approver: "none", guardrails, connectionType };
  }

  async requestApproval(
    taskId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    tier: 1 | 2 | 3,
    requestedBy: string,
  ): Promise<ApprovalRequest> {
    const result = await this.pool.query(
      `INSERT INTO approvals (task_id, tool_name, tool_input, tier, requested_by, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [taskId, toolName, JSON.stringify(toolInput), tier, requestedBy],
    );

    return this.rowToApproval(result.rows[0]);
  }

  async resolve(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: string,
  ): Promise<ApprovalRequest> {
    const result = await this.pool.query(
      `UPDATE approvals
       SET status = $1, approved_by = $2, resolved_at = now()
       WHERE id = $3
       RETURNING *`,
      [decision, resolvedBy, approvalId],
    );

    if (result.rows.length === 0) {
      throw new Error(`Approval ${approvalId} not found`);
    }

    return this.rowToApproval(result.rows[0]);
  }

  async getApproval(approvalId: string): Promise<ApprovalRequest | null> {
    const result = await this.pool.query(
      "SELECT * FROM approvals WHERE id = $1",
      [approvalId],
    );

    if (result.rows.length === 0) return null;
    return this.rowToApproval(result.rows[0]);
  }

  async getPendingByTask(taskId: string): Promise<ApprovalRequest[]> {
    const result = await this.pool.query(
      "SELECT * FROM approvals WHERE task_id = $1 AND status = 'pending' ORDER BY created_at",
      [taskId],
    );

    return result.rows.map((row: Record<string, unknown>) =>
      this.rowToApproval(row),
    );
  }

  getGuardrails(toolName: string): string | null {
    const policy = this.policies[toolName] ?? this.policies["_default"];
    return policy?.guardrails ?? null;
  }

  private rowToApproval(row: Record<string, unknown>): ApprovalRequest {
    return {
      id: row.id as string,
      taskId: row.task_id as string,
      toolName: row.tool_name as string,
      toolInput: (row.tool_input ?? {}) as Record<string, unknown>,
      tier: row.tier as 1 | 2 | 3,
      requestedBy: row.requested_by as string,
      approvedBy: (row.approved_by as string) ?? null,
      status: row.status as ApprovalRequest["status"],
      guardrailOutput: (row.guardrail_output as string) ?? null,
      createdAt: row.created_at as Date,
      resolvedAt: (row.resolved_at as Date) ?? null,
    };
  }
}
