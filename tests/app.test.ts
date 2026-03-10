import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/agent/prompt.js";

describe("app smoke test", () => {
  it("can build a system prompt", () => {
    const prompt = buildSystemPrompt({
      agentName: "Sentinel",
      personality: "Cautious.",
      guardrails: {},
    });
    expect(prompt).toContain("Sentinel");
    expect(prompt).toContain("AI assistant built for this team");
  });
});
