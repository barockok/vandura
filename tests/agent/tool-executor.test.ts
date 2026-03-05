// tests/agent/tool-executor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolExecutor } from "../../src/agent/tool-executor.js";
import type { ApprovalEngine, ClassificationResult } from "../../src/approval/engine.js";
import type { AuditLogger } from "../../src/audit/logger.js";

function mockClassify(tier: 1 | 2 | 3): ClassificationResult {
  return {
    tier,
    requiresApproval: tier > 1,
    approver: tier === 1 ? "none" : tier === 2 ? "initiator" : "checker",
    guardrails: null,
  };
}

describe("ToolExecutor", () => {
  let executor: ToolExecutor;
  let mockApprovalEngine: Partial<ApprovalEngine>;
  let mockAuditLogger: Partial<AuditLogger>;
  let mockToolRunner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockApprovalEngine = {
      classify: vi.fn().mockReturnValue(mockClassify(1)),
      requestApproval: vi.fn().mockResolvedValue({ id: "apr-1", status: "pending" }),
    };
    mockAuditLogger = {
      log: vi.fn().mockResolvedValue(undefined),
    };
    mockToolRunner = vi.fn().mockResolvedValue({ output: '{"rows":[]}', isError: false });
    executor = new ToolExecutor({
      approvalEngine: mockApprovalEngine as ApprovalEngine,
      auditLogger: mockAuditLogger as AuditLogger,
      taskId: "task-1",
      initiatorSlackId: "U123",
      checkerSlackId: null,
      toolRunners: { db_query: mockToolRunner },
    });
  });

  it("auto-executes tier 1 tools", async () => {
    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(1));
    const result = await executor.execute("db_query", { sql: "SELECT 1" }, "call-1");
    expect(result.isError).toBeFalsy();
    expect(mockToolRunner).toHaveBeenCalledWith({ sql: "SELECT 1" });
    expect(mockAuditLogger.log).toHaveBeenCalled();
  });

  it("returns pending approval for tier 2 tools", async () => {
    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(2));
    const result = await executor.execute("db_query", { sql: "UPDATE x SET y=1" }, "call-2");
    expect(result.output).toContain("approval");
    expect(result.needsApproval).toBe(true);
    expect(result.approvalId).toBe("apr-1");
    expect(result.tier).toBe(2);
    expect(mockToolRunner).not.toHaveBeenCalled();
  });

  it("returns pending approval for tier 3 tools", async () => {
    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(3));
    const result = await executor.execute("db_query", { sql: "DROP TABLE x" }, "call-3");
    expect(result.needsApproval).toBe(true);
    expect(result.tier).toBe(3);
    expect(mockToolRunner).not.toHaveBeenCalled();
  });

  it("returns error for unknown tools", async () => {
    const result = await executor.execute("unknown_tool", {}, "call-4");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unknown_tool");
  });

  it("executes tool after approval is granted", async () => {
    const result = await executor.executeApproved("db_query", { sql: "SELECT 1" }, "U_APPROVER");
    expect(result.isError).toBeFalsy();
    expect(mockToolRunner).toHaveBeenCalledWith({ sql: "SELECT 1" });
  });
});
