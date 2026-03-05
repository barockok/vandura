// tests/slack/approval-flow.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackApprovalFlow } from "../../src/slack/approval-flow.js";

describe("SlackApprovalFlow", () => {
  let flow: SlackApprovalFlow;
  let mockSay: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSay = vi.fn().mockResolvedValue({ ts: "msg-ts" });
    flow = new SlackApprovalFlow();
  });

  it("posts tier 2 approval request mentioning initiator", async () => {
    const msg = await flow.postApprovalRequest({
      say: mockSay,
      threadTs: "thread-1",
      approvalId: "apr-1",
      toolName: "db_query",
      toolInput: { sql: "SELECT * FROM users" },
      tier: 2,
      initiatorSlackId: "U_INIT",
      checkerSlackId: null,
    });

    expect(mockSay).toHaveBeenCalledTimes(1);
    const call = mockSay.mock.calls[0][0];
    expect(call.thread_ts).toBe("thread-1");
    expect(call.text).toContain("<@U_INIT>");
    expect(call.text).toContain("db_query");
    expect(call.text).toContain("approve");
  });

  it("posts tier 3 approval request mentioning checker", async () => {
    await flow.postApprovalRequest({
      say: mockSay,
      threadTs: "thread-1",
      approvalId: "apr-1",
      toolName: "db_write",
      toolInput: { sql: "DELETE FROM logs" },
      tier: 3,
      initiatorSlackId: "U_INIT",
      checkerSlackId: "U_CHECK",
    });

    const call = mockSay.mock.calls[0][0];
    expect(call.text).toContain("<@U_CHECK>");
    expect(call.text).toContain("DELETE FROM logs");
  });

  it("parses 'approve' reply as approved", () => {
    expect(flow.parseDecision("approve")).toBe("approved");
    expect(flow.parseDecision("approved")).toBe("approved");
    expect(flow.parseDecision("yes")).toBe("approved");
    expect(flow.parseDecision("APPROVE")).toBe("approved");
  });

  it("parses 'deny' reply as rejected", () => {
    expect(flow.parseDecision("deny")).toBe("rejected");
    expect(flow.parseDecision("denied")).toBe("rejected");
    expect(flow.parseDecision("reject")).toBe("rejected");
    expect(flow.parseDecision("no")).toBe("rejected");
  });

  it("returns null for unrelated messages", () => {
    expect(flow.parseDecision("what about this?")).toBeNull();
    expect(flow.parseDecision("let me think")).toBeNull();
  });

  it("validates approver for tier 2 (must be initiator)", () => {
    expect(flow.canApprove({ tier: 2, userId: "U_INIT", initiatorSlackId: "U_INIT", checkerSlackId: null })).toBe(true);
    expect(flow.canApprove({ tier: 2, userId: "U_OTHER", initiatorSlackId: "U_INIT", checkerSlackId: null })).toBe(false);
  });

  it("validates approver for tier 3 (must be checker, not initiator)", () => {
    expect(flow.canApprove({ tier: 3, userId: "U_CHECK", initiatorSlackId: "U_INIT", checkerSlackId: "U_CHECK" })).toBe(true);
    expect(flow.canApprove({ tier: 3, userId: "U_INIT", initiatorSlackId: "U_INIT", checkerSlackId: "U_CHECK" })).toBe(false);
  });
});
