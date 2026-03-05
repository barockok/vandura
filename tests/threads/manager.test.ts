import { describe, it, expect, afterAll, beforeAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { ThreadManager } from "../../src/threads/manager.js";

describe("ThreadManager", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let manager: ThreadManager;
  let agentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    manager = new ThreadManager(pool);

    // Seed an agent for the foreign key
    const agentResult = await pool.query(
      `INSERT INTO agents (name, role) VALUES ('test-agent', 'helper') RETURNING id`
    );
    agentId = agentResult.rows[0].id;
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("creates a task and finds it by thread", async () => {
    const task = await manager.createTask({
      slackThreadTs: "1234567890.123456",
      slackChannel: "C01ABCDEF",
      agentId,
      initiatorSlackId: "U_INITIATOR",
      topic: "Fix the deployment",
    });

    expect(task.id).toBeDefined();
    expect(task.status).toBe("open");
    expect(task.topic).toBe("Fix the deployment");
    expect(task.closedAt).toBeNull();
    expect(task.checkerSlackId).toBeNull();

    const found = await manager.findByThread("C01ABCDEF", "1234567890.123456");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
    expect(found!.agentId).toBe(agentId);
    expect(found!.initiatorSlackId).toBe("U_INITIATOR");
  });

  it("returns null when thread not found", async () => {
    const found = await manager.findByThread("C_NONE", "0000000000.000000");
    expect(found).toBeNull();
  });

  it("sets checker on a task", async () => {
    const task = await manager.createTask({
      slackThreadTs: "2000000000.000001",
      slackChannel: "C01ABCDEF",
      agentId,
      initiatorSlackId: "U_INITIATOR",
    });

    expect(task.checkerSlackId).toBeNull();

    const updated = await manager.setChecker(task.id, "U_CHECKER");
    expect(updated.checkerSlackId).toBe("U_CHECKER");

    // Verify persisted
    const fetched = await manager.findByThread("C01ABCDEF", "2000000000.000001");
    expect(fetched!.checkerSlackId).toBe("U_CHECKER");
  });

  it("appends and retrieves messages in order", async () => {
    const task = await manager.createTask({
      slackThreadTs: "3000000000.000001",
      slackChannel: "C01ABCDEF",
      agentId,
      initiatorSlackId: "U_INITIATOR",
    });

    const msg1 = await manager.addMessage(task.id, "user", "Hello agent");
    const msg2 = await manager.addMessage(task.id, "assistant", "Hi there!", {
      model: "claude-3",
    });
    const msg3 = await manager.addMessage(task.id, "tool", "result: 42", {
      toolName: "calculator",
    });

    expect(msg1.role).toBe("user");
    expect(msg2.metadata).toEqual({ model: "claude-3" });
    expect(msg3.metadata).toEqual({ toolName: "calculator" });

    const messages = await manager.getMessages(task.id);
    expect(messages).toHaveLength(3);
    expect(messages[0].id).toBe(msg1.id);
    expect(messages[1].id).toBe(msg2.id);
    expect(messages[2].id).toBe(msg3.id);
    expect(messages[0].content).toBe("Hello agent");
    expect(messages[1].content).toBe("Hi there!");
    expect(messages[2].content).toBe("result: 42");
  });

  it("closes a task with completed status", async () => {
    const task = await manager.createTask({
      slackThreadTs: "4000000000.000001",
      slackChannel: "C01ABCDEF",
      agentId,
      initiatorSlackId: "U_INITIATOR",
    });

    expect(task.status).toBe("open");
    expect(task.closedAt).toBeNull();

    const closed = await manager.closeTask(task.id, "completed");
    expect(closed.status).toBe("completed");
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it("closes a task with cancelled status", async () => {
    const task = await manager.createTask({
      slackThreadTs: "5000000000.000001",
      slackChannel: "C01ABCDEF",
      agentId,
      initiatorSlackId: "U_INITIATOR",
    });

    const closed = await manager.closeTask(task.id, "cancelled");
    expect(closed.status).toBe("cancelled");
    expect(closed.closedAt).toBeInstanceOf(Date);
  });
});
