# Vandura Phase 3: Permission Layer & User Onboarding

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add role-based permission enforcement and a Slack-based user onboarding flow so that tool access is governed by user roles and new channel members are automatically onboarded.

**Architecture:** A `PermissionService` maps Slack users to Vandura users with roles (PM/Engineering/Business). Each role defines which tools are accessible and their max tier. The service is injected into the tool execution path — before classifying a tool call, it checks whether the user's role permits that tool at that tier. An `OnboardingFlow` detects `member_joined_channel` events, DMs the user to select a role, persists them in the `users` table, and confirms access.

**Tech Stack:** TypeScript, Vitest, `pg` (Postgres), Slack Bolt SDK, Zod (config validation)

---

## Context: Current Codebase

- `src/config/types.ts` — Already has `RolePermissionSchema`, `RolesConfigSchema`, `RolePermission` type. Defines `{ agents: string[], tool_tiers: Record<string, { max_tier: number }> }` per role.
- `src/config/loader.ts` — Already has `loadRoles()` function that parses `config/roles.yml`.
- `config/roles.yml` — Already has PM, Engineering, Business roles with tool_tiers.
- `src/approval/engine.ts` — `classify()` resolves tier. `classifyDynamic()` for EXPLAIN-based.
- `src/agent/tool-executor.ts` — `ToolExecutor.execute()` classifies then auto-executes or requests approval.
- `src/app.ts` — Main wiring. `onMention` creates task, executor, runtime. `onThreadMessage` handles approvals, checker, lifecycle.
- `src/slack/gateway.ts` — `onMemberJoined(handler)` already registered.
- DB: `users` table exists with `slack_id`, `role`, `tool_overrides`, `is_active`, `onboarded_at`.
- DB: `shared_connections`, `user_shared_access`, `user_connections` tables exist in migration 001.

---

### Task 1: UserManager — CRUD for Vandura Users

Build a `UserManager` class that handles Slack user → Vandura user mapping with role management.

**Files:**
- Create: `src/users/manager.ts`
- Create: `src/users/types.ts`
- Test: `tests/users/manager.test.ts`

**Step 1: Write the types**

```typescript
// src/users/types.ts
export interface VanduraUser {
  id: string;
  slackId: string;
  displayName: string | null;
  role: string;
  toolOverrides: Record<string, { max_tier?: number; blocked?: boolean }>;
  isActive: boolean;
  onboardedAt: Date | null;
  createdAt: Date;
}
```

**Step 2: Write the failing test**

```typescript
// tests/users/manager.test.ts
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
      "db_query": { max_tier: 3 },
      "db_write": { blocked: true },
    });
    expect(updated.toolOverrides).toEqual({
      "db_query": { max_tier: 3 },
      "db_write": { blocked: true },
    });
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run tests/users/manager.test.ts`
Expected: FAIL — module not found

**Step 4: Implement UserManager**

```typescript
// src/users/manager.ts
import type { Pool } from "../db/connection.js";
import type { VanduraUser } from "./types.js";

export class UserManager {
  constructor(private pool: Pool) {}

  async findOrCreate(slackId: string, displayName: string, role: string): Promise<VanduraUser> {
    const result = await this.pool.query(
      `INSERT INTO users (slack_id, display_name, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (slack_id) DO UPDATE SET display_name = COALESCE($2, users.display_name)
       RETURNING *`,
      [slackId, displayName, role],
    );
    return this.rowToUser(result.rows[0]);
  }

  async findBySlackId(slackId: string): Promise<VanduraUser | null> {
    const result = await this.pool.query(
      "SELECT * FROM users WHERE slack_id = $1",
      [slackId],
    );
    if (result.rows.length === 0) return null;
    return this.rowToUser(result.rows[0]);
  }

  async setRole(userId: string, role: string): Promise<VanduraUser> {
    const result = await this.pool.query(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING *",
      [role, userId],
    );
    if (result.rows.length === 0) throw new Error(`User ${userId} not found`);
    return this.rowToUser(result.rows[0]);
  }

  async markOnboarded(userId: string): Promise<VanduraUser> {
    const result = await this.pool.query(
      "UPDATE users SET onboarded_at = now() WHERE id = $1 RETURNING *",
      [userId],
    );
    if (result.rows.length === 0) throw new Error(`User ${userId} not found`);
    return this.rowToUser(result.rows[0]);
  }

  async setToolOverrides(
    userId: string,
    overrides: Record<string, { max_tier?: number; blocked?: boolean }>,
  ): Promise<VanduraUser> {
    const result = await this.pool.query(
      "UPDATE users SET tool_overrides = $1 WHERE id = $2 RETURNING *",
      [JSON.stringify(overrides), userId],
    );
    if (result.rows.length === 0) throw new Error(`User ${userId} not found`);
    return this.rowToUser(result.rows[0]);
  }

  private rowToUser(row: Record<string, unknown>): VanduraUser {
    return {
      id: row.id as string,
      slackId: row.slack_id as string,
      displayName: (row.display_name as string) ?? null,
      role: row.role as string,
      toolOverrides: (row.tool_overrides as Record<string, { max_tier?: number; blocked?: boolean }>) ?? {},
      isActive: row.is_active as boolean,
      onboardedAt: (row.onboarded_at as Date) ?? null,
      createdAt: row.created_at as Date,
    };
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/users/manager.test.ts`
Expected: PASS (7 tests)

**Step 6: Commit**

```bash
git add src/users/ tests/users/
git commit -m "feat: UserManager for Slack-to-Vandura user mapping"
```

---

### Task 2: PermissionService — Role-Based Tool Access Control

Build a `PermissionService` that checks whether a user's role allows a specific tool at a specific tier. Loads role definitions from `config/roles.yml` (already parsed by `loadRoles()`). Respects per-user overrides from the `users.tool_overrides` column.

**Files:**
- Create: `src/permissions/service.ts`
- Test: `tests/permissions/service.test.ts`

**Step 1: Write the failing test**

```typescript
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
      "db_write": { max_tier: 0 }, // blocked
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/permissions/service.test.ts`
Expected: FAIL — module not found

**Step 3: Implement PermissionService**

```typescript
// src/permissions/service.ts
import type { RolePermission } from "../config/types.js";
import type { VanduraUser } from "../users/types.js";

export interface AccessCheckResult {
  allowed: boolean;
  reason?: string;
}

export class PermissionService {
  constructor(private roles: Record<string, RolePermission>) {}

  checkToolAccess(user: VanduraUser, toolName: string, tier: number): AccessCheckResult {
    if (!user.isActive) {
      return { allowed: false, reason: "User account is inactive." };
    }

    if (!user.onboardedAt) {
      return { allowed: false, reason: "User has not completed onboarding." };
    }

    // Check per-user overrides first
    const override = user.toolOverrides[toolName];
    if (override?.blocked) {
      return { allowed: false, reason: `Tool "${toolName}" is blocked for this user.` };
    }
    if (override?.max_tier !== undefined) {
      if (tier <= override.max_tier) {
        return { allowed: true };
      }
      return { allowed: false, reason: `Tool "${toolName}" max tier for this user is ${override.max_tier}.` };
    }

    // Check role-based permissions
    const rolePerms = this.roles[user.role];
    if (!rolePerms) {
      // Unknown role: allow tier 1 only
      return tier <= 1
        ? { allowed: true }
        : { allowed: false, reason: `Unknown role "${user.role}", max tier is 1.` };
    }

    const toolTier = rolePerms.tool_tiers[toolName];
    if (!toolTier) {
      // Tool not listed in role config: allow tier 1 only
      return tier <= 1
        ? { allowed: true }
        : { allowed: false, reason: `Tool "${toolName}" not in role "${user.role}" permissions, max tier is 1.` };
    }

    if (tier <= toolTier.max_tier) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Role "${user.role}" allows "${toolName}" up to max tier ${toolTier.max_tier}, but tier ${tier} was requested.`,
    };
  }

  getAvailableTools(role: string): string[] {
    const rolePerms = this.roles[role];
    if (!rolePerms) return [];
    return Object.entries(rolePerms.tool_tiers)
      .filter(([, v]) => v.max_tier > 0)
      .map(([k]) => k);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/permissions/service.test.ts`
Expected: PASS (12 tests)

**Step 5: Commit**

```bash
git add src/permissions/ tests/permissions/
git commit -m "feat: PermissionService for role-based tool access control"
```

---

### Task 3: Wire PermissionService into ToolExecutor

Integrate the permission check into the tool execution path. Before the `ApprovalEngine.classify()` call, check if the user has access to the tool at the classified tier. If not, return an error instead of executing or requesting approval.

**Files:**
- Modify: `src/agent/tool-executor.ts`
- Modify: `tests/agent/tool-executor.test.ts`

**Step 1: Add failing tests**

Add these tests to the existing `tests/agent/tool-executor.test.ts`:

```typescript
  it("denies tool when user permission check fails", async () => {
    const permissionService = {
      checkToolAccess: vi.fn().mockReturnValue({
        allowed: false,
        reason: 'Role "pm" allows "db_query" up to max tier 1, but tier 2 was requested.',
      }),
    };
    const executorWithPerms = new ToolExecutor({
      approvalEngine: mockApprovalEngine as ApprovalEngine,
      auditLogger: mockAuditLogger as AuditLogger,
      taskId: "task-1",
      initiatorSlackId: "U123",
      checkerSlackId: null,
      toolRunners: { db_query: mockToolRunner },
      permissionService: permissionService as any,
      initiatorUser: { role: "pm", isActive: true, onboardedAt: new Date() } as any,
    });

    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(2));
    const result = await executorWithPerms.execute("db_query", { sql: "UPDATE x" }, "call-p1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("permission");
    expect(mockToolRunner).not.toHaveBeenCalled();
  });

  it("allows tool when permission check passes", async () => {
    const permissionService = {
      checkToolAccess: vi.fn().mockReturnValue({ allowed: true }),
    };
    const executorWithPerms = new ToolExecutor({
      approvalEngine: mockApprovalEngine as ApprovalEngine,
      auditLogger: mockAuditLogger as AuditLogger,
      taskId: "task-1",
      initiatorSlackId: "U123",
      checkerSlackId: null,
      toolRunners: { db_query: mockToolRunner },
      permissionService: permissionService as any,
      initiatorUser: { role: "engineering", isActive: true, onboardedAt: new Date() } as any,
    });

    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(1));
    const result = await executorWithPerms.execute("db_query", { sql: "SELECT 1" }, "call-p2");
    expect(result.isError).toBeFalsy();
    expect(mockToolRunner).toHaveBeenCalled();
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tool-executor.test.ts`
Expected: FAIL — ToolExecutor doesn't accept permissionService/initiatorUser

**Step 3: Update ToolExecutor**

Add optional `permissionService` and `initiatorUser` to `ToolExecutorConfig`:

```typescript
// In src/agent/tool-executor.ts, update the config interface:
import type { PermissionService } from "../permissions/service.js";
import type { VanduraUser } from "../users/types.js";

interface ToolExecutorConfig {
  approvalEngine: ApprovalEngine;
  auditLogger: AuditLogger;
  taskId: string;
  initiatorSlackId: string;
  checkerSlackId: string | null;
  toolRunners: Record<string, ToolRunnerFn>;
  permissionService?: PermissionService;
  initiatorUser?: VanduraUser;
}
```

In the `execute()` method, after the runner check and after classification, add the permission check:

```typescript
    // After: const classification = this.config.approvalEngine.classify(toolName, toolInput);
    // Add:
    if (this.config.permissionService && this.config.initiatorUser) {
      const access = this.config.permissionService.checkToolAccess(
        this.config.initiatorUser,
        toolName,
        classification.tier,
      );
      if (!access.allowed) {
        await this.config.auditLogger.log({
          taskId: this.config.taskId,
          action: "tool_denied",
          actor: this.config.initiatorSlackId,
          detail: { toolName, tier: classification.tier, reason: access.reason },
        });
        return {
          output: `Permission denied: ${access.reason}`,
          isError: true,
        };
      }
    }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/tool-executor.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add src/agent/tool-executor.ts tests/agent/tool-executor.test.ts
git commit -m "feat: integrate PermissionService into ToolExecutor"
```

---

### Task 4: OnboardingFlow — Slack DM Role Selection

Build an `OnboardingFlow` class that handles the user onboarding conversation via DM. When a user joins a channel, the bot DMs them with role options and processes their reply.

**Files:**
- Create: `src/slack/onboarding-flow.ts`
- Test: `tests/slack/onboarding-flow.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/slack/onboarding-flow.test.ts
import { describe, it, expect, vi } from "vitest";
import { OnboardingFlow } from "../../src/slack/onboarding-flow.js";

describe("OnboardingFlow", () => {
  const availableRoles = ["pm", "engineering", "business"];
  const flow = new OnboardingFlow(availableRoles);

  it("builds a welcome message with role options", () => {
    const msg = flow.buildWelcomeMessage("C_CHANNEL");
    expect(msg).toContain("Welcome");
    expect(msg).toContain("pm");
    expect(msg).toContain("engineering");
    expect(msg).toContain("business");
  });

  it("parses a valid role reply", () => {
    expect(flow.parseRoleReply("engineering")).toBe("engineering");
    expect(flow.parseRoleReply("  PM  ")).toBe("pm");
    expect(flow.parseRoleReply("Business")).toBe("business");
  });

  it("returns null for invalid role reply", () => {
    expect(flow.parseRoleReply("admin")).toBeNull();
    expect(flow.parseRoleReply("hello")).toBeNull();
  });

  it("parses numbered role reply", () => {
    expect(flow.parseRoleReply("1")).toBe("pm");
    expect(flow.parseRoleReply("2")).toBe("engineering");
    expect(flow.parseRoleReply("3")).toBe("business");
  });

  it("builds confirmation message", () => {
    const msg = flow.buildConfirmationMessage("engineering");
    expect(msg).toContain("engineering");
    expect(msg).toContain("ready");
  });

  it("sends DM to user", async () => {
    const mockClient = {
      conversations: {
        open: vi.fn().mockResolvedValue({ ok: true, channel: { id: "D_DM" } }),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    await flow.sendDM(mockClient as any, "U_USER", "Hello!");
    expect(mockClient.conversations.open).toHaveBeenCalledWith({ users: "U_USER" });
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith({
      channel: "D_DM",
      text: "Hello!",
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/onboarding-flow.test.ts`
Expected: FAIL — module not found

**Step 3: Implement OnboardingFlow**

```typescript
// src/slack/onboarding-flow.ts

interface SlackClient {
  conversations: {
    open: (params: { users: string }) => Promise<{ ok: boolean; channel?: { id: string } }>;
  };
  chat: {
    postMessage: (params: { channel: string; text: string }) => Promise<unknown>;
  };
}

export class OnboardingFlow {
  constructor(private availableRoles: string[]) {}

  buildWelcomeMessage(channelId: string): string {
    const roleList = this.availableRoles
      .map((r, i) => `  ${i + 1}. *${r}*`)
      .join("\n");

    return [
      `Welcome! You've joined a channel with Vandura AI agents.`,
      ``,
      `To get started, please select your role by replying with the role name or number:`,
      ``,
      roleList,
      ``,
      `Your role determines which tools and access levels are available to you.`,
    ].join("\n");
  }

  parseRoleReply(text: string): string | null {
    const normalized = text.trim().toLowerCase();

    // Check by number
    const num = parseInt(normalized, 10);
    if (!isNaN(num) && num >= 1 && num <= this.availableRoles.length) {
      return this.availableRoles[num - 1];
    }

    // Check by name
    if (this.availableRoles.includes(normalized)) {
      return normalized;
    }

    return null;
  }

  buildConfirmationMessage(role: string): string {
    return `You're all set! Your role is *${role}*. You're ready to use the agents in any channel where Vandura is deployed. Just @mention an agent to get started.`;
  }

  async sendDM(client: SlackClient, userId: string, text: string): Promise<void> {
    const dmResult = await client.conversations.open({ users: userId });
    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error(`Failed to open DM with user ${userId}`);
    }
    await client.chat.postMessage({ channel: dmResult.channel.id, text });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/onboarding-flow.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/slack/onboarding-flow.ts tests/slack/onboarding-flow.test.ts
git commit -m "feat: OnboardingFlow for Slack DM-based role selection"
```

---

### Task 5: Wire Permissions + Onboarding into app.ts

Integrate the PermissionService, UserManager, and OnboardingFlow into the main application.

**Files:**
- Modify: `src/app.ts`

**Step 1: Update imports and initialization**

Add to top of `src/app.ts`:
```typescript
import { loadRoles } from "./config/loader.js";
import { UserManager } from "./users/manager.js";
import { PermissionService } from "./permissions/service.js";
import { OnboardingFlow } from "./slack/onboarding-flow.js";
```

After loading `agents`, add:
```typescript
  const roles = await loadRoles(path.join(configDir, "roles.yml"));
  const userManager = new UserManager(pool);
  const permissionService = new PermissionService(roles);
  const availableRoles = Object.keys(roles);
  const onboardingFlow = new OnboardingFlow(availableRoles);
```

**Step 2: Add DM listener state**

After the existing state maps, add:
```typescript
  const pendingOnboarding = new Map<string, string>(); // DM channel → slack user ID
```

**Step 3: Wire onMemberJoined**

Add before the return statement:
```typescript
  gateway.onMemberJoined(async ({ user, channel }) => {
    // Skip if user is the bot itself
    if (authResult.user_id && user === authResult.user_id) return;

    // Check if user already exists and is onboarded
    const existingUser = await userManager.findBySlackId(user);
    if (existingUser?.onboardedAt) return;

    try {
      const welcomeMsg = onboardingFlow.buildWelcomeMessage(channel);
      await onboardingFlow.sendDM(slackApp.client as any, user, welcomeMsg);

      // Track pending onboarding (we need to listen for DM replies)
      const dmResult = await slackApp.client.conversations.open({ users: user });
      if (dmResult.ok && dmResult.channel?.id) {
        pendingOnboarding.set(dmResult.channel.id, user);
      }

      await auditLogger.log({
        action: "onboarding_started", actor: user,
        detail: { channel, dmSent: true },
      });
    } catch (err) {
      console.error(`[ONBOARDING] Failed to DM user ${user}:`, err);
    }
  });
```

**Step 4: Add DM message handler for onboarding replies**

The gateway already listens for `message` events. We need to handle DM replies for onboarding. Add a new message handler in the Slack app directly (not through gateway, since DMs aren't thread-based):

```typescript
  // Handle DM replies for onboarding
  slackApp.event("message", async ({ event }) => {
    const msg = event as unknown as Record<string, unknown>;
    const channelId = msg.channel as string;
    const userId = msg.user as string;
    const text = (msg.text as string) ?? "";

    // Check if this is a pending onboarding DM
    if (!pendingOnboarding.has(channelId)) return;
    const pendingUserId = pendingOnboarding.get(channelId);
    if (pendingUserId !== userId) return;

    // Skip thread replies and bot messages
    if (msg.thread_ts) return;
    if (msg.bot_id) return;

    const role = onboardingFlow.parseRoleReply(text);
    if (!role) {
      await slackApp.client.chat.postMessage({
        channel: channelId,
        text: `I didn't recognize that role. Please reply with one of: ${availableRoles.join(", ")}`,
      });
      return;
    }

    // Look up display name via Slack API
    let displayName = userId;
    try {
      const userInfo = await slackApp.client.users.info({ user: userId });
      displayName = userInfo.user?.profile?.display_name
        || userInfo.user?.real_name
        || userId;
    } catch { /* use userId as fallback */ }

    // Create/update user and mark onboarded
    const vanduraUser = await userManager.findOrCreate(userId, displayName, role);
    await userManager.markOnboarded(vanduraUser.id);
    pendingOnboarding.delete(channelId);

    const confirmMsg = onboardingFlow.buildConfirmationMessage(role);
    await slackApp.client.chat.postMessage({ channel: channelId, text: confirmMsg });

    await auditLogger.log({
      action: "onboarding_completed", actor: userId,
      detail: { role, userId: vanduraUser.id },
    });
  });
```

**Step 5: Update onMention to look up user and pass to ToolExecutor**

In the `onMention` handler, after creating the task and before creating the executor, add user lookup:

```typescript
    // Look up or auto-create user (default to business role if not onboarded)
    let vanduraUser = await userManager.findBySlackId(user);
    if (!vanduraUser) {
      // User not onboarded but mentioning the bot — create with default role
      vanduraUser = await userManager.findOrCreate(user, user, "business");
    }
```

Update the `ToolExecutor` constructor to pass permissionService and user:

```typescript
    const executor = new ToolExecutor({
      approvalEngine, auditLogger, taskId: task.id,
      initiatorSlackId: user, checkerSlackId: null,
      toolRunners: {
        db_query: async (input) => {
          const r = await pgTool.execute(input as { sql: string });
          return r.error
            ? { output: r.error, isError: true }
            : { output: JSON.stringify({ rows: r.rows, rowCount: r.rowCount, columns: r.columns }) };
        },
      },
      permissionService,
      initiatorUser: vanduraUser,
    });
```

**Step 6: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run --exclude 'tests/e2e/**'`
Expected: PASS

**Step 7: Update the return to include new services**

```typescript
  return {
    start: async () => {
      await gateway.start();
      startHealthServer(healthCheck);
    },
    pool, toolDbPool, gateway, threadManager,
    approvalEngine, auditLogger, storage, healthCheck,
    userManager, permissionService, onboardingFlow,
  };
```

**Step 8: Commit**

```bash
git add src/app.ts
git commit -m "feat: wire permissions + onboarding into app"
```

---

### Task 6: Roles Config File — Create Example + Validation

Ensure the roles config is validated and documented with an example file.

**Files:**
- Create: `config/roles.example.yml`
- Modify: `src/app.ts` — add graceful fallback if roles.yml missing

**Step 1: Create example config**

```yaml
# config/roles.example.yml
# Role definitions — controls which tools each role can access and at what tier.
# max_tier: 0 = blocked, 1 = auto-execute only, 2 = initiator confirms, 3 = checker approves
roles:
  pm:
    agents: [atlas, scribe]
    tool_tiers:
      db_query: { max_tier: 1 }
      db_write: { max_tier: 0 }
      confluence_create: { max_tier: 2 }

  engineering:
    agents: [atlas, scribe, courier, sentinel]
    tool_tiers:
      db_query: { max_tier: 3 }
      db_write: { max_tier: 3 }
      confluence_create: { max_tier: 2 }
      rest_api: { max_tier: 3 }

  business:
    agents: [atlas, scribe]
    tool_tiers:
      db_query: { max_tier: 1 }
      confluence_create: { max_tier: 1 }
```

**Step 2: Add graceful fallback in app.ts**

Update the roles loading to handle missing file:

```typescript
  let roles: Record<string, RolePermission> = {};
  try {
    roles = await loadRoles(path.join(configDir, "roles.yml"));
  } catch {
    console.warn("[CONFIG] roles.yml not found — running without role-based permissions");
  }
```

Also add the import for `RolePermission`:
```typescript
import type { RolePermission } from "./config/types.js";
```

**Step 3: Commit**

```bash
git add config/roles.example.yml src/app.ts
git commit -m "feat: roles config example + graceful fallback"
```

---

### Task 7: Integration Test — Permission + Onboarding Flow

Write an integration test that verifies the full permission check and onboarding flow against a real database.

**Files:**
- Create: `tests/integration/permissions.test.ts`

**Step 1: Write the test**

```typescript
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
      tool_tiers: { db_query: { max_tier: 1 } },
    },
    engineering: {
      agents: ["atlas", "sentinel"],
      tool_tiers: { db_query: { max_tier: 3 }, db_write: { max_tier: 3 } },
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
    // 1. Create user (simulating onboarding)
    const user = await userMgr.findOrCreate("U_INTEG", "Integration User", "pm");
    expect(user.onboardedAt).toBeNull();

    // 2. Non-onboarded user is denied
    const denied = permSvc.checkToolAccess(user, "db_query", 1);
    expect(denied.allowed).toBe(false);

    // 3. Mark onboarded
    const onboarded = await userMgr.markOnboarded(user.id);

    // 4. PM can use db_query at tier 1
    const allowed = permSvc.checkToolAccess(onboarded, "db_query", 1);
    expect(allowed.allowed).toBe(true);

    // 5. PM cannot use db_query at tier 2
    const denied2 = permSvc.checkToolAccess(onboarded, "db_query", 2);
    expect(denied2.allowed).toBe(false);

    // 6. Upgrade to engineering
    const upgraded = await userMgr.setRole(user.id, "engineering");

    // 7. Engineering can use db_query at tier 3
    const allowed3 = permSvc.checkToolAccess(upgraded, "db_query", 3);
    expect(allowed3.allowed).toBe(true);

    // 8. Add user override to block db_write
    const withOverride = await userMgr.setToolOverrides(user.id, {
      db_write: { blocked: true },
    });
    const blocked = permSvc.checkToolAccess(withOverride, "db_write", 1);
    expect(blocked.allowed).toBe(false);
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/integration/permissions.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test: integration test for permission + onboarding flow"
```

---

### Task 8: Final Cleanup

1. Add `.env.example` entry for roles config location (optional)
2. Run full test suite
3. Verify typecheck

**Step 1: Run all tests and typecheck**

Run: `npx tsc --noEmit && npx vitest run --exclude 'tests/e2e/**'`
Expected: All tests pass

**Step 2: Commit any cleanup**

```bash
git add -A
git commit -m "chore: Phase 3 cleanup — permissions + onboarding complete"
```

---

## Summary

| Task | What | Depends On |
|------|------|------------|
| 1 | UserManager (CRUD) | — |
| 2 | PermissionService (role-based access) | Task 1 |
| 3 | Wire permissions into ToolExecutor | Tasks 1-2 |
| 4 | OnboardingFlow (Slack DM) | — |
| 5 | Wire everything into app.ts | Tasks 1-4 |
| 6 | Roles config example + fallback | Task 5 |
| 7 | Integration test | Tasks 1-5 |
| 8 | Final cleanup | All |
