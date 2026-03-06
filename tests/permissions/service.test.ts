// tests/permissions/service.test.ts
import { describe, it, expect } from "vitest";
import { PermissionService } from "../../src/permissions/service.js";
import type { RolePermission } from "../../src/config/types.js";
import type { VanduraUser } from "../../src/users/types.js";

const roles: Record<string, RolePermission> = {
  pm: {
    agents: ["atlas", "scribe"],
    tool_tiers: {
      "db_query": { max_tier: 1 },
      "db_write": { max_tier: 0 },
      "confluence_create": { max_tier: 2 },
    },
  },
  engineering: {
    agents: ["atlas", "scribe", "courier", "sentinel"],
    tool_tiers: {
      "db_query": { max_tier: 3 },
      "db_write": { max_tier: 3 },
      "confluence_create": { max_tier: 2 },
    },
  },
};

function makeUser(overrides?: Partial<VanduraUser>): VanduraUser {
  return {
    id: "u-1",
    slackId: "U123",
    displayName: "Test",
    role: "pm",
    toolOverrides: {},
    isActive: true,
    onboardedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

describe("PermissionService", () => {
  const svc = new PermissionService(roles);

  it("allows tool within role max_tier", () => {
    const user = makeUser({ role: "pm" });
    const result = svc.checkToolAccess(user, "db_query", 1);
    expect(result.allowed).toBe(true);
  });

  it("denies tool exceeding role max_tier", () => {
    const user = makeUser({ role: "pm" });
    const result = svc.checkToolAccess(user, "db_query", 2);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("max tier");
  });

  it("denies tool with max_tier 0 (blocked)", () => {
    const user = makeUser({ role: "pm" });
    const result = svc.checkToolAccess(user, "db_write", 1);
    expect(result.allowed).toBe(false);
  });

  it("allows tool for engineering at higher tier", () => {
    const user = makeUser({ role: "engineering" });
    const result = svc.checkToolAccess(user, "db_query", 3);
    expect(result.allowed).toBe(true);
  });

  it("allows unknown tools at tier 1 by default", () => {
    const user = makeUser({ role: "pm" });
    const result = svc.checkToolAccess(user, "unknown_tool", 1);
    expect(result.allowed).toBe(true);
  });

  it("denies unknown tools at tier 2+", () => {
    const user = makeUser({ role: "pm" });
    const result = svc.checkToolAccess(user, "unknown_tool", 2);
    expect(result.allowed).toBe(false);
  });

  it("user override elevates max_tier", () => {
    const user = makeUser({
      role: "pm",
      toolOverrides: { "db_query": { max_tier: 3 } },
    });
    const result = svc.checkToolAccess(user, "db_query", 3);
    expect(result.allowed).toBe(true);
  });

  it("user override blocks a tool", () => {
    const user = makeUser({
      role: "engineering",
      toolOverrides: { "db_write": { blocked: true } },
    });
    const result = svc.checkToolAccess(user, "db_write", 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("denies inactive users", () => {
    const user = makeUser({ isActive: false });
    const result = svc.checkToolAccess(user, "db_query", 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("inactive");
  });

  it("denies non-onboarded users", () => {
    const user = makeUser({ onboardedAt: null });
    const result = svc.checkToolAccess(user, "db_query", 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("onboard");
  });

  it("returns available tools for a role", () => {
    const tools = svc.getAvailableTools("engineering");
    expect(tools).toContain("db_query");
    expect(tools).toContain("db_write");
  });

  it("returns empty for unknown role", () => {
    const tools = svc.getAvailableTools("nonexistent");
    expect(tools).toEqual([]);
  });
});
