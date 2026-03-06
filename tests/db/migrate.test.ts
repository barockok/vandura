import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";

describe("runMigrations", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();
    pool = createPool(container.getConnectionUri());
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("applies all migrations and creates expected tables", async () => {
    await runMigrations(pool);

    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    const tableNames = tables.rows.map((r: { table_name: string }) => r.table_name);

    expect(tableNames).toContain("schema_migrations");
    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("shared_connections");
    expect(tableNames).toContain("user_shared_access");
    expect(tableNames).toContain("user_connections");
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("approvals");
    expect(tableNames).toContain("audit_log");
  });

  it("is idempotent — running twice does not fail", async () => {
    // First run already happened in previous test
    await expect(runMigrations(pool)).resolves.not.toThrow();

    // Verify schema_migrations tracks all applied migrations
    const result = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].version).toBe(1);
  });
});
