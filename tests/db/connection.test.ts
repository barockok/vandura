import { describe, it, expect, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";

describe("createPool", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it("connects to Postgres and executes SELECT 1", async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();
    const connectionUri = container.getConnectionUri();
    pool = createPool(connectionUri);

    const result = await pool.query("SELECT 1 AS num");
    expect(result.rows[0].num).toBe(1);
  });
});
