import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { ApprovalEngine } from "../../src/approval/engine.js";
import type { ToolPolicies } from "../../src/config/types.js";

describe("ApprovalEngine", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let engine: ApprovalEngine;
  let taskId: string;

  const policies: ToolPolicies = {
    read_file: { tier: 1, guardrails: null, checker: "peer-based" },
    write_file: {
      tier: 2,
      guardrails: "Must not overwrite protected files",
      checker: "peer-based",
    },
    deploy_production: {
      tier: 3,
      guardrails: "Requires production deployment checklist",
      checker: "role-based",
    },
    _default: { tier: 3, guardrails: "Default guardrail", checker: "any" },
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();

    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);

    engine = new ApprovalEngine(pool, policies);

    // Seed an agent
    const agentResult = await pool.query(
      `INSERT INTO agents (name, role, tools) VALUES ('test-agent', 'engineer', '["read_file","write_file"]') RETURNING id`,
    );
    const agentId = agentResult.rows[0].id;

    // Seed a task
    const taskResult = await pool.query(
      `INSERT INTO tasks (agent_id, initiator_slack_id, topic, status) VALUES ($1, 'U_INITIATOR', 'test task', 'open') RETURNING id`,
      [agentId],
    );
    taskId = taskResult.rows[0].id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("classifies tier 1 tool as auto-approve (no approval needed)", () => {
    const result = engine.classify("read_file", {});
    expect(result.tier).toBe(1);
    expect(result.requiresApproval).toBe(false);
    expect(result.approver).toBe("none");
  });

  it("classifies tier 2 tool as needing initiator approval", () => {
    const result = engine.classify("write_file", { path: "/tmp/test.txt" });
    expect(result.tier).toBe(2);
    expect(result.requiresApproval).toBe(true);
    expect(result.approver).toBe("initiator");
    expect(result.guardrails).toBe("Must not overwrite protected files");
  });

  it("classifies tier 3 tool as needing checker approval", () => {
    const result = engine.classify("deploy_production", { env: "prod" });
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
    expect(result.approver).toBe("checker");
    expect(result.guardrails).toBe(
      "Requires production deployment checklist",
    );
  });

  it("falls back to _default policy for unknown tools", () => {
    const result = engine.classify("unknown_tool", {});
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
    expect(result.approver).toBe("checker");
    expect(result.guardrails).toBe("Default guardrail");
  });

  it("creates and resolves an approval request", async () => {
    const approval = await engine.requestApproval(
      taskId,
      "write_file",
      { path: "/tmp/test.txt" },
      2,
      "U_INITIATOR",
    );

    expect(approval.status).toBe("pending");
    expect(approval.taskId).toBe(taskId);
    expect(approval.toolName).toBe("write_file");
    expect(approval.tier).toBe(2);
    expect(approval.requestedBy).toBe("U_INITIATOR");
    expect(approval.approvedBy).toBeNull();
    expect(approval.resolvedAt).toBeNull();

    // Verify it shows up in pending
    const pending = await engine.getPendingByTask(taskId);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some((p) => p.id === approval.id)).toBe(true);

    // Resolve
    const resolved = await engine.resolve(
      approval.id,
      "approved",
      "U_CHECKER",
    );
    expect(resolved.status).toBe("approved");
    expect(resolved.approvedBy).toBe("U_CHECKER");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    // Verify it's no longer pending
    const pendingAfter = await engine.getPendingByTask(taskId);
    expect(pendingAfter.some((p) => p.id === approval.id)).toBe(false);

    // Verify getApproval
    const fetched = await engine.getApproval(approval.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("approved");
  });

  it("returns guardrails for a tool", () => {
    expect(engine.getGuardrails("write_file")).toBe(
      "Must not overwrite protected files",
    );
    expect(engine.getGuardrails("deploy_production")).toBe(
      "Requires production deployment checklist",
    );
    expect(engine.getGuardrails("read_file")).toBeNull();
    expect(engine.getGuardrails("unknown_tool")).toBe("Default guardrail");
  });
});
