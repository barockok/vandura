// tests/slack/onboarding-flow.test.ts
import { describe, it, expect, vi } from "vitest";
import { OnboardingFlow } from "../../src/slack/onboarding-flow.js";

describe("OnboardingFlow", () => {
  const availableRoles = ["pm", "engineering", "business"];
  const flow = new OnboardingFlow(availableRoles);

  it("builds a welcome message with role options", () => {
    const msg = flow.buildWelcomeMessage("C_CHANNEL");
    expect(msg).toContain("Welcome");
    expect(msg).toContain("pm");
    expect(msg).toContain("engineering");
    expect(msg).toContain("business");
  });

  it("parses a valid role reply", () => {
    expect(flow.parseRoleReply("engineering")).toBe("engineering");
    expect(flow.parseRoleReply("  PM  ")).toBe("pm");
    expect(flow.parseRoleReply("Business")).toBe("business");
  });

  it("returns null for invalid role reply", () => {
    expect(flow.parseRoleReply("admin")).toBeNull();
    expect(flow.parseRoleReply("hello")).toBeNull();
  });

  it("parses numbered role reply", () => {
    expect(flow.parseRoleReply("1")).toBe("pm");
    expect(flow.parseRoleReply("2")).toBe("engineering");
    expect(flow.parseRoleReply("3")).toBe("business");
  });

  it("builds confirmation message", () => {
    const msg = flow.buildConfirmationMessage("engineering");
    expect(msg).toContain("engineering");
    expect(msg).toContain("ready");
  });

  it("sends DM to user", async () => {
    const mockClient = {
      conversations: {
        open: vi.fn().mockResolvedValue({ ok: true, channel: { id: "D_DM" } }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    await flow.sendDM(mockClient as any, "U_USER", "Hello!");
    expect(mockClient.conversations.open).toHaveBeenCalledWith({ users: "U_USER" });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "D_DM",
      text: "Hello!",
    });
  });
});
