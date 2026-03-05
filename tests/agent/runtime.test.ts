import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRuntime } from "../../src/agent/runtime.js";

const makeConfig = (overrides?: Record<string, unknown>) => ({
  anthropicApiKey: "test-key-not-real",
  agentConfig: {
    name: "TestAgent",
    role: "admin",
    tools: ["mcp-db"],
    max_concurrent_tasks: 1,
    personality: "Helpful and concise.",
    system_prompt_extra: "Extra instructions here.",
  },
  toolPolicies: {
    mcp__db__query: {
      tier: 2 as const,
      guardrails: "Always run EXPLAIN first.",
      checker: "peer-based" as const,
    },
    _default: {
      tier: 2 as const,
      checker: "peer-based" as const,
    },
  },
  ...overrides,
});

describe("AgentRuntime", () => {
  it("can be constructed with correct config", () => {
    const runtime = new AgentRuntime(makeConfig());
    expect(runtime).toBeInstanceOf(AgentRuntime);
  });

  it("accepts optional anthropicBaseUrl", () => {
    const runtime = new AgentRuntime(
      makeConfig({ anthropicBaseUrl: "https://custom.api.example.com" })
    );
    expect(runtime).toBeInstanceOf(AgentRuntime);
  });

  it("returns empty history initially", () => {
    const runtime = new AgentRuntime(makeConfig());
    expect(runtime.getHistory()).toEqual([]);
  });

  it("loadHistory sets conversation history", () => {
    const runtime = new AgentRuntime(makeConfig());
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    runtime.loadHistory(messages);
    expect(runtime.getHistory()).toEqual(messages);
  });

  it("getHistory returns a copy, not a reference", () => {
    const runtime = new AgentRuntime(makeConfig());
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Hello" },
    ];
    runtime.loadHistory(messages);

    const history = runtime.getHistory();
    history.push({ role: "assistant", content: "tampered" });

    expect(runtime.getHistory()).toHaveLength(1);
  });

  it("loadHistory makes a copy of the input", () => {
    const runtime = new AgentRuntime(makeConfig());
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "Hello" },
    ];
    runtime.loadHistory(messages);

    messages.push({ role: "assistant", content: "tampered" });

    expect(runtime.getHistory()).toHaveLength(1);
  });
});
