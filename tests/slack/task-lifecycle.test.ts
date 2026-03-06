import { describe, it, expect } from "vitest";
import { TaskLifecycle } from "../../src/slack/task-lifecycle.js";

describe("TaskLifecycle", () => {
  const lifecycle = new TaskLifecycle();

  it("detects close commands", () => {
    expect(lifecycle.parseCommand("done")).toBe("completed");
    expect(lifecycle.parseCommand("close")).toBe("completed");
    expect(lifecycle.parseCommand("task complete")).toBe("completed");
    expect(lifecycle.parseCommand("cancel")).toBe("cancelled");
    expect(lifecycle.parseCommand("abort")).toBe("cancelled");
  });

  it("returns null for non-commands", () => {
    expect(lifecycle.parseCommand("what about this?")).toBeNull();
    expect(lifecycle.parseCommand("do the thing")).toBeNull();
  });

  it("builds a task summary", () => {
    const summary = lifecycle.buildSummary({
      taskId: "t-1",
      status: "completed",
      messageCount: 8,
      toolCallCount: 3,
      approvalCount: 1,
      duration: "5m 30s",
      inputTokens: 1234,
      outputTokens: 567,
    });
    expect(summary).toContain("completed");
    expect(summary).toContain("8 messages");
    expect(summary).toContain("3 tool calls");
    expect(summary).toContain("1 approval");
    expect(summary).toContain("1,234 in");
    expect(summary).toContain("567 out");
  });
});
