// tests/integration/permissions.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { UserManager } from "../../src/users/manager.js";
import { PermissionService } from "../../src/permissions/service.js";
import type { RolePermission } from "../../src/config/types.js";

describe("Permission + Onboarding integration", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let userMgr: UserManager;
  let permSvc: PermissionService;

  const roles: Record<string, RolePermission> = {
    pm: {
      agents: ["atlas"],
      tool_tiers: { mcp__postgres__query: { max_tier: 1 } },
    },
    engineering: {
      agents: ["atlas", "sentinel"],
      tool_tiers: { mcp__postgres__query: { max_tier: 3 }, mcp__postgres__execute: { max_tier: 3 } },
    },
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();
    pool = createPool(container.getConnectionUri());
    await runMigrations(pool);
    userMgr = new UserManager(pool);
    permSvc = new PermissionService(roles);
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("full onboarding → permission check flow", async () => {
    // 1. Create user (not yet onboarded)
    const user = await userMgr.findOrCreate("U_INTEG", "Integration User", "pm");
    expect(user.onboardedAt).toBeNull();

    // 2. Non-onboarded user can still access shared tools (role/tier gates apply)
    const allowedBeforeOnboard = permSvc.checkToolAccess(user, "mcp__postgres__query", 1);
    expect(allowedBeforeOnboard.allowed).toBe(true);

    // 3. Mark onboarded (for role selection, not access gating)
    const onboarded = await userMgr.markOnboarded(user.id);

    // 4. PM can use db_query at tier 1
    const allowed = permSvc.checkToolAccess(onboarded, "mcp__postgres__query", 1);
    expect(allowed.allowed).toBe(true);

    // 5. PM cannot use db_query at tier 2
    const denied2 = permSvc.checkToolAccess(onboarded, "mcp__postgres__query", 2);
    expect(denied2.allowed).toBe(false);

    // 6. Upgrade to engineering
    const upgraded = await userMgr.setRole(user.id, "engineering");

    // 7. Engineering can use db_query at tier 3
    const allowed3 = permSvc.checkToolAccess(upgraded, "mcp__postgres__query", 3);
    expect(allowed3.allowed).toBe(true);

    // 8. Add user override to block db_write
    const withOverride = await userMgr.setToolOverrides(user.id, {
      mcp__postgres__execute: { blocked: true },
    });
    const blocked = permSvc.checkToolAccess(withOverride, "mcp__postgres__execute", 1);
    expect(blocked.allowed).toBe(false);
  });
});
