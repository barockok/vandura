import { describe, it, expect, vi, beforeEach } from "vitest";
import { auditEmitter } from "../../src/audit/emitter.js";
import { postToolUseHook } from "../../src/hooks/post-tool-use.js";

describe("postToolUseHook", () => {
  beforeEach(() => {
    auditEmitter.removeAllListeners();
  });

  it("emits a tool_use event with correct payload", async () => {
    const listener = vi.fn();
    auditEmitter.on("tool_use", listener);

    const input = {
      session_id: "sess-123",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "file.txt" },
    };

    const result = await postToolUseHook(input as any, "tu-456", {});

    expect(result).toEqual({});
    expect(listener).toHaveBeenCalledOnce();

    const event = listener.mock.calls[0][0];
    expect(event.sessionId).toBe("sess-123");
    expect(event.toolName).toBe("Bash");
    expect(event.toolInput).toEqual({ command: "ls" });
    expect(event.toolOutput).toEqual({ stdout: "file.txt" });
    expect(event.toolUseId).toBe("tu-456");
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it("defaults toolUseId to empty string when undefined", async () => {
    const listener = vi.fn();
    auditEmitter.on("tool_use", listener);

    const input = {
      session_id: "sess-789",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
      tool_response: { content: "hello" },
    };

    await postToolUseHook(input as any, undefined as any, {});

    const event = listener.mock.calls[0][0];
    expect(event.toolUseId).toBe("");
  });

  it("returns empty object", async () => {
    const input = {
      session_id: "s",
      tool_name: "t",
      tool_input: {},
      tool_response: {},
    };

    const result = await postToolUseHook(input as any, "id", {});
    expect(result).toEqual({});
  });
});
