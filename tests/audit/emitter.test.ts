import { describe, it, expect, beforeEach } from "vitest";
import {
  AuditEmitter,
  type ToolUseEvent,
  type SessionStartEvent,
  type ApprovalRequestedEvent,
  type ApprovalResolvedEvent,
} from "../../src/audit/emitter.js";

describe("AuditEmitter", () => {
  let emitter: AuditEmitter;

  beforeEach(() => {
    emitter = new AuditEmitter();
  });

  it("emits tool_use events with correct payload", () => {
    const received: ToolUseEvent[] = [];
    emitter.on("tool_use", (event) => received.push(event));

    const event: ToolUseEvent = {
      sessionId: "sess-1",
      toolName: "web_search",
      toolInput: { query: "test" },
      toolOutput: { results: [] },
      toolUseId: "tu-1",
      timestamp: new Date("2026-03-18T00:00:00Z"),
    };
    emitter.emit("tool_use", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("emits session_start events with correct payload", () => {
    const received: SessionStartEvent[] = [];
    emitter.on("session_start", (event) => received.push(event));

    const event: SessionStartEvent = {
      sessionId: "sess-2",
      channelId: "C123",
      userId: "U456",
      timestamp: new Date("2026-03-18T00:00:00Z"),
    };
    emitter.emit("session_start", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("emits approval_requested events with correct payload", () => {
    const received: ApprovalRequestedEvent[] = [];
    emitter.on("approval_requested", (event) => received.push(event));

    const event: ApprovalRequestedEvent = {
      sessionId: "sess-3",
      toolName: "db_write",
      tier: 3,
      timestamp: new Date("2026-03-18T00:00:00Z"),
    };
    emitter.emit("approval_requested", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("emits approval_resolved events with correct payload", () => {
    const received: ApprovalResolvedEvent[] = [];
    emitter.on("approval_resolved", (event) => received.push(event));

    const event: ApprovalResolvedEvent = {
      sessionId: "sess-4",
      toolName: "db_write",
      decision: "allow",
      approverId: "U789",
      timestamp: new Date("2026-03-18T00:00:00Z"),
    };
    emitter.emit("approval_resolved", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("supports multiple listeners on the same event", () => {
    let count = 0;
    emitter.on("tool_use", () => count++);
    emitter.on("tool_use", () => count++);

    emitter.emit("tool_use", {
      sessionId: "sess-5",
      toolName: "test",
      toolInput: {},
      toolOutput: null,
      toolUseId: "tu-2",
      timestamp: new Date(),
    });

    expect(count).toBe(2);
  });

  it("does not cross-emit between event types", () => {
    let called = false;
    emitter.on("session_start", () => {
      called = true;
    });

    emitter.emit("tool_use", {
      sessionId: "sess-6",
      toolName: "test",
      toolInput: {},
      toolOutput: null,
      toolUseId: "tu-3",
      timestamp: new Date(),
    });

    expect(called).toBe(false);
  });
});
