// tests/agent/runtime.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRuntime } from "../../src/agent/runtime.js";

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = {
      create: vi.fn(),
    };
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic };
});

const baseConfig = {
  anthropicApiKey: "test-key",
  agentConfig: {
    name: "TestAgent",
    role: "admin",
    tools: ["db_query"],
    max_concurrent_tasks: 1,
  },
  toolPolicies: {},
};

describe("AgentRuntime", () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new AgentRuntime(baseConfig);
  });

  const mockUsage = { input_tokens: 100, output_tokens: 50 };

  it("returns text response when no tool calls", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: mockUsage,
    });
    (runtime as any).client.messages.create = mockCreate;

    const result = await runtime.chat("hi");
    expect(result.text).toBe("Hello!");
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("invokes tool executor when Claude requests tool use", async () => {
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me query that." },
          { type: "tool_use", id: "call_1", name: "db_query", input: { sql: "SELECT 1" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 200, output_tokens: 80 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "The result is 1." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 300, output_tokens: 60 },
      });

    (runtime as any).client.messages.create = mockCreate;

    const toolExecutor = vi.fn().mockResolvedValue({
      output: JSON.stringify({ rows: [{ "?column?": 1 }], rowCount: 1 }),
    });

    const result = await runtime.chat("what is 1?", { toolExecutor });
    expect(toolExecutor).toHaveBeenCalledWith("db_query", { sql: "SELECT 1" }, "call_1");
    expect(result.text).toBe("The result is 1.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: "db_query",
      input: { sql: "SELECT 1" },
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 140 });
  });

  it("passes tool definitions to the API", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
      usage: mockUsage,
    });
    (runtime as any).client.messages.create = mockCreate;

    const tools = [{
      name: "db_query",
      description: "Run SQL",
      input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
    }];

    await runtime.chat("hi", { tools });
    expect(mockCreate.mock.calls[0][0].tools).toEqual(tools);
  });

  it("limits tool-use loop to prevent infinite loops", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "tool_use", id: "call_x", name: "db_query", input: { sql: "SELECT 1" } },
      ],
      stop_reason: "tool_use",
      usage: mockUsage,
    });
    (runtime as any).client.messages.create = mockCreate;

    const toolExecutor = vi.fn().mockResolvedValue({ output: "ok" });

    await expect(runtime.chat("loop", { toolExecutor, maxToolRounds: 3 }))
      .rejects.toThrow("too many tool-use rounds");
  });

  it("handles tool execution errors", async () => {
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "call_err", name: "db_query", input: { sql: "BAD" } },
        ],
        stop_reason: "tool_use",
        usage: mockUsage,
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Sorry, error." }],
        stop_reason: "end_turn",
        usage: mockUsage,
      });
    (runtime as any).client.messages.create = mockCreate;

    const toolExecutor = vi.fn().mockResolvedValue({
      output: "relation does not exist",
      isError: true,
    });

    const result = await runtime.chat("bad query", { toolExecutor });
    expect(result.text).toBe("Sorry, error.");
  });
});
