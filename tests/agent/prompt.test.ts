import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/agent/prompt.js";

describe("buildSystemPrompt", () => {
  it("includes agent name", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("Atlas");
    expect(prompt).toContain("AI assistant built for this team");
  });

  it("includes Slack context", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("Slack");
  });

  it("includes personality when provided", () => {
    const prompt = buildSystemPrompt({
      agentName: "Atlas",
      personality: "You are friendly and concise.",
    });
    expect(prompt).toContain("You are friendly and concise.");
  });

  it("does not include personality section when not provided", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).not.toContain("Personality");
  });

  it("includes systemPromptExtra when provided", () => {
    const prompt = buildSystemPrompt({
      agentName: "Atlas",
      systemPromptExtra: "Always respond in bullet points.",
    });
    expect(prompt).toContain("Always respond in bullet points.");
  });

  it("includes guardrails section when provided", () => {
    const prompt = buildSystemPrompt({
      agentName: "Atlas",
      guardrails: {
        mcp__db__query: "Always run EXPLAIN before executing queries.",
        mcp__db__write: "Never drop tables.",
      },
    });
    expect(prompt).toContain("mcp__db__query");
    expect(prompt).toContain("Always run EXPLAIN before executing queries.");
    expect(prompt).toContain("mcp__db__write");
    expect(prompt).toContain("Never drop tables.");
  });

  it("does not include guardrails section when not provided", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).not.toContain("Guardrails");
  });

  it("does not include guardrails section when empty", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas", guardrails: {} });
    expect(prompt).not.toContain("Guardrails");
  });

  it("includes approval rules for tier 1/2/3", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("Tier 1");
    expect(prompt).toContain("Tier 2");
    expect(prompt).toContain("Tier 3");
  });

  it("includes Slack thread awareness guidance", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("side conversations");
    expect(prompt).toContain("Not every message is directed at you");
  });

  it("includes white-label identity — never mentions Claude or Anthropic", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("Never mention Claude, Anthropic, Claude Code");
    expect(prompt).toContain("Never reference your model name");
  });

  it("does not contain 'Vandura system'", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).not.toContain("Vandura system");
  });

  it("includes memory guidance with directory path", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas", memoryDir: "/data/memory" });
    expect(prompt).toContain("/data/memory");
    expect(prompt).toContain("Write");
    expect(prompt).toContain("Read");
  });

  it("does not include memory section when memoryDir not provided", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).not.toContain("Persistent Memory");
  });
});
