import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { UserManager } from "../../src/users/manager.js";

describe("UserManager", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let mgr: UserManager;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    mgr = new UserManager(pool);
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("creates a new user from Slack ID", async () => {
    const user = await mgr.findOrCreate("U_ALICE", "Alice", "engineering");
    expect(user.slackId).toBe("U_ALICE");
    expect(user.displayName).toBe("Alice");
    expect(user.role).toBe("engineering");
    expect(user.isActive).toBe(true);
    expect(user.onboardedAt).toBeNull();
  });

  it("returns existing user on duplicate slackId", async () => {
    const u1 = await mgr.findOrCreate("U_BOB", "Bob", "pm");
    const u2 = await mgr.findOrCreate("U_BOB", "Bob", "pm");
    expect(u1.id).toBe(u2.id);
  });

  it("finds user by Slack ID", async () => {
    await mgr.findOrCreate("U_CAROL", "Carol", "business");
    const found = await mgr.findBySlackId("U_CAROL");
    expect(found).not.toBeNull();
    expect(found!.role).toBe("business");
  });

  it("returns null for unknown Slack ID", async () => {
    const found = await mgr.findBySlackId("U_NONEXISTENT");
    expect(found).toBeNull();
  });

  it("updates user role", async () => {
    const user = await mgr.findOrCreate("U_DAN", "Dan", "business");
    const updated = await mgr.setRole(user.id, "engineering");
    expect(updated.role).toBe("engineering");
  });

  it("marks user as onboarded", async () => {
    const user = await mgr.findOrCreate("U_EVE", "Eve", "pm");
    expect(user.onboardedAt).toBeNull();
    const onboarded = await mgr.markOnboarded(user.id);
    expect(onboarded.onboardedAt).toBeInstanceOf(Date);
  });

  it("sets tool overrides", async () => {
    const user = await mgr.findOrCreate("U_FRANK", "Frank", "pm");
    const updated = await mgr.setToolOverrides(user.id, {
      "mcp__postgres__query": { max_tier: 3 },
      "mcp__postgres__execute": { blocked: true },
    });
    expect(updated.toolOverrides).toEqual({
      "mcp__postgres__query": { max_tier: 3 },
      "mcp__postgres__execute": { blocked: true },
    });
  });
});
