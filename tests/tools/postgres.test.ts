import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { PostgresTool } from "../../src/tools/postgres.js";

describe("PostgresTool", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tool: PostgresTool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();
    pool = createPool(container.getConnectionUri());
    await pool.query("CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT, age INT)");
    await pool.query("INSERT INTO test_users (name, age) VALUES ('Alice', 30), ('Bob', 25), ('Charlie', 35)");
    tool = new PostgresTool(pool);
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("executes a SELECT query and returns rows", async () => {
    const result = await tool.execute({ sql: "SELECT name, age FROM test_users ORDER BY name" });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual({ name: "Alice", age: 30 });
    expect(result.rowCount).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("returns column metadata", async () => {
    const result = await tool.execute({ sql: "SELECT name FROM test_users LIMIT 1" });
    expect(result.columns).toEqual(["name"]);
  });

  it("handles query errors gracefully", async () => {
    const result = await tool.execute({ sql: "SELECT * FROM nonexistent_table" });
    expect(result.error).toBeDefined();
    expect(result.rows).toEqual([]);
  });

  it("runs EXPLAIN and returns the plan", async () => {
    const result = await tool.explain("SELECT * FROM test_users WHERE age > 25");
    expect(result.plan).toBeDefined();
    expect(result.plan.length).toBeGreaterThan(0);
    expect(result.estimatedRows).toBeGreaterThanOrEqual(0);
  });

  it("returns the tool definition for Anthropic API", () => {
    const def = tool.definition();
    expect(def.name).toBe("db_query");
    expect(def.input_schema).toBeDefined();
  });
});
