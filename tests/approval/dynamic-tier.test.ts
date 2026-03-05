// tests/approval/dynamic-tier.test.ts
import { describe, it, expect, vi } from "vitest";
import { ApprovalEngine } from "../../src/approval/engine.js";
import type { Pool } from "../../src/db/connection.js";

describe("Dynamic tier classification", () => {
  const mockPool = { query: vi.fn() } as unknown as Pool;
  const policies = {
    db_query: {
      tier: "dynamic" as const,
      guardrails: "Run EXPLAIN first.",
      checker: "peer-based" as const,
    },
  };
  const engine = new ApprovalEngine(mockPool, policies);

  it("classifies as tier 1 for small queries", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 50, hasSeqScan: false });
    expect(result.tier).toBe(1);
    expect(result.requiresApproval).toBe(false);
  });

  it("classifies as tier 2 for large queries", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 5000, hasSeqScan: false });
    expect(result.tier).toBe(2);
    expect(result.requiresApproval).toBe(true);
  });

  it("classifies as tier 2 for sequential scans", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 50, hasSeqScan: true });
    expect(result.tier).toBe(2);
  });

  it("classifies as tier 3 for very large queries", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 100_000, hasSeqScan: true });
    expect(result.tier).toBe(3);
  });

  it("falls back to tier 3 for dynamic policies when classify is called", () => {
    const result = engine.classify("db_query", {});
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
  });
});
