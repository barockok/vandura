import type { ApprovalEngine } from "../approval/engine.js";
import type { AuditLogger } from "../audit/logger.js";
import type { ToolResult } from "../tools/types.js";

type ToolRunnerFn = (input: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolExecutorResult extends ToolResult {
  needsApproval?: boolean;
  approvalId?: string;
  tier?: 1 | 2 | 3;
  approver?: "none" | "initiator" | "checker";
}

interface ToolExecutorConfig {
  approvalEngine: ApprovalEngine;
  auditLogger: AuditLogger;
  taskId: string;
  initiatorSlackId: string;
  checkerSlackId: string | null;
  toolRunners: Record<string, ToolRunnerFn>;
}

export class ToolExecutor {
  private config: ToolExecutorConfig;

  constructor(config: ToolExecutorConfig) {
    this.config = config;
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
  ): Promise<ToolExecutorResult> {
    const runner = this.config.toolRunners[toolName];
    if (!runner) {
      return {
        output: `Tool "${toolName}" is not available.`,
        isError: true,
      };
    }

    const classification = this.config.approvalEngine.classify(toolName, toolInput);

    if (!classification.requiresApproval) {
      // Tier 1: auto-execute
      const result = await runner(toolInput);
      await this.config.auditLogger.log({
        taskId: this.config.taskId,
        action: "tool_executed",
        actor: "system",
        detail: { toolName, toolInput, tier: classification.tier, autoApproved: true },
      });
      return result;
    }

    // Tier 2 or 3: request approval
    const approval = await this.config.approvalEngine.requestApproval(
      this.config.taskId,
      toolName,
      toolInput,
      classification.tier,
      this.config.initiatorSlackId,
    );

    await this.config.auditLogger.log({
      taskId: this.config.taskId,
      action: "approval_requested",
      actor: this.config.initiatorSlackId,
      detail: {
        toolName,
        toolInput,
        tier: classification.tier,
        approver: classification.approver,
        approvalId: approval.id,
      },
    });

    return {
      output: `This action requires ${classification.approver} approval (tier ${classification.tier}). Approval request created.`,
      needsApproval: true,
      approvalId: approval.id,
      tier: classification.tier,
      approver: classification.approver,
    };
  }

  async executeApproved(
    toolName: string,
    toolInput: Record<string, unknown>,
    approvedBy: string,
  ): Promise<ToolResult> {
    const runner = this.config.toolRunners[toolName];
    if (!runner) {
      return { output: `Tool "${toolName}" is not available.`, isError: true };
    }

    const result = await runner(toolInput);

    await this.config.auditLogger.log({
      taskId: this.config.taskId,
      action: "tool_executed",
      actor: approvedBy,
      detail: { toolName, toolInput, approvedBy },
    });

    return result;
  }
}
