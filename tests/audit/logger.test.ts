import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { AuditLogger } from "../../src/audit/logger.js";

describe("AuditLogger", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let logger: AuditLogger;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    logger = new AuditLogger(pool);
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("logs an action and retrieves it by actor", async () => {
    await logger.log({
      action: "task.created",
      actor: "user:alice",
      detail: { source: "slack", channel: "#general" },
    });

    const rows = await logger.getByActor("user:alice");
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("task.created");
    expect(rows[0].actor).toBe("user:alice");
    expect(rows[0].detail).toEqual({ source: "slack", channel: "#general" });
    expect(rows[0].task_id).toBeNull();
    expect(rows[0].agent_id).toBeNull();
    expect(rows[0].id).toBeDefined();
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it("logs with task_id and agent_id and retrieves by task_id", async () => {
    // Insert a dummy agent
    const agentResult = await pool.query(
      "INSERT INTO agents (name, role) VALUES ($1, $2) RETURNING id",
      ["test-agent", "assistant"]
    );
    const agentId: string = agentResult.rows[0].id;

    // Insert a dummy task referencing the agent
    const taskResult = await pool.query(
      "INSERT INTO tasks (agent_id, topic, status) VALUES ($1, $2, $3) RETURNING id",
      [agentId, "Test task", "open"]
    );
    const taskId: string = taskResult.rows[0].id;

    await logger.log({
      taskId,
      agentId,
      action: "tool.executed",
      actor: "agent:test-agent",
      detail: { tool: "web_search", duration_ms: 320 },
    });

    const rows = await logger.getByTaskId(taskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(taskId);
    expect(rows[0].agent_id).toBe(agentId);
    expect(rows[0].action).toBe("tool.executed");
    expect(rows[0].actor).toBe("agent:test-agent");
    expect(rows[0].detail).toEqual({ tool: "web_search", duration_ms: 320 });
  });

  it("returns results ordered by created_at descending", async () => {
    const actor = "user:bob";

    await logger.log({ action: "first", actor, detail: {} });
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 50));
    await logger.log({ action: "second", actor, detail: {} });

    const rows = await logger.getByActor(actor);
    expect(rows).toHaveLength(2);
    expect(rows[0].action).toBe("second");
    expect(rows[1].action).toBe("first");
  });
});
