import { describe, it, expect } from "vitest";
import { CheckerFlow } from "../../src/slack/checker-flow.js";

describe("CheckerFlow", () => {
  const flow = new CheckerFlow();

  it("extracts user ID from @mention in text", () => {
    expect(flow.extractCheckerFromReply("checker is <@U0ABC123>")).toBe("U0ABC123");
    expect(flow.extractCheckerFromReply("<@U0XYZ789> should check")).toBe("U0XYZ789");
  });

  it("returns null when no @mention found", () => {
    expect(flow.extractCheckerFromReply("no checker needed")).toBeNull();
  });

  it("returns 'skip' for skip keywords", () => {
    expect(flow.extractCheckerFromReply("skip")).toBe("skip");
    expect(flow.extractCheckerFromReply("none")).toBe("skip");
    expect(flow.extractCheckerFromReply("no checker")).toBe("skip");
  });

  it("builds the checker nomination prompt", () => {
    const msg = flow.buildNominationPrompt();
    expect(msg).toContain("checker");
    expect(msg).toContain("skip");
  });
});
