# Remove PostgreSQL Dependency — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove PostgreSQL as an app dependency, replacing session/approval storage with Redis + Slack thread metadata backup, and audit logging with an EventEmitter.

**Architecture:** SessionStore class wraps Redis (primary) + Slack message metadata (backup). AuditEmitter replaces DB inserts with Node.js EventEmitter. Agent config read from YAML only. Legacy modules deleted.

**Tech Stack:** ioredis (already in deps for BullMQ), Slack Bolt API, Node.js EventEmitter

**Design doc:** `docs/plans/2026-03-18-remove-postgresql-design.md`

---

### Task 1: Create AuditEmitter

The simplest new component — no external dependencies.

**Files:**
- Create: `src/audit/emitter.ts`
- Create: `tests/audit/emitter.test.ts`
- Delete: `src/audit/logger.ts`
- Delete: `tests/audit/logger.test.ts`

**Step 1: Write the failing test**

Create `tests/audit/emitter.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { auditEmitter } from "../../src/audit/emitter.js";

describe("AuditEmitter", () => {
  it("emits tool_use events", () => {
    const handler = vi.fn();
    auditEmitter.on("tool_use", handler);

    auditEmitter.emit("tool_use", {
      sessionId: "sess-1",
      toolName: "mcp__postgres__query",
      toolInput: { query: "SELECT 1" },
      toolOutput: { rows: [] },
      toolUseId: "tu-1",
      timestamp: new Date().toISOString(),
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].toolName).toBe("mcp__postgres__query");

    auditEmitter.off("tool_use", handler);
  });

  it("emits session_start events", () => {
    const handler = vi.fn();
    auditEmitter.on("session_start", handler);

    auditEmitter.emit("session_start", {
      sessionId: "sess-1",
      channelId: "C123",
      userId: "U456",
      timestamp: new Date().toISOString(),
    });

    expect(handler).toHaveBeenCalledOnce();
    auditEmitter.off("session_start", handler);
  });

  it("emits approval_requested events", () => {
    const handler = vi.fn();
    auditEmitter.on("approval_requested", handler);

    auditEmitter.emit("approval_requested", {
      sessionId: "sess-1",
      toolName: "db_write",
      tier: 3,
      timestamp: new Date().toISOString(),
    });

    expect(handler).toHaveBeenCalledOnce();
    auditEmitter.off("approval_requested", handler);
  });

  it("emits approval_resolved events", () => {
    const handler = vi.fn();
    auditEmitter.on("approval_resolved", handler);

    auditEmitter.emit("approval_resolved", {
      sessionId: "sess-1",
      toolName: "db_write",
      decision: "allow",
      approverId: "U789",
      timestamp: new Date().toISOString(),
    });

    expect(handler).toHaveBeenCalledOnce();
    auditEmitter.off("approval_resolved", handler);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/audit/emitter.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/audit/emitter.ts`:

```typescript
import { EventEmitter } from "node:events";

export interface ToolUseEvent {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown>;
  toolUseId: string;
  timestamp: string;
}

export interface SessionStartEvent {
  sessionId: string;
  channelId: string;
  userId: string;
  timestamp: string;
}

export interface ApprovalRequestedEvent {
  sessionId: string;
  toolName: string;
  tier: number;
  timestamp: string;
}

export interface ApprovalResolvedEvent {
  sessionId: string;
  toolName: string;
  decision: "allow" | "deny";
  approverId: string;
  timestamp: string;
}

export interface AuditEvents {
  tool_use: [ToolUseEvent];
  session_start: [SessionStartEvent];
  approval_requested: [ApprovalRequestedEvent];
  approval_resolved: [ApprovalResolvedEvent];
}

class AuditEmitter extends EventEmitter<AuditEvents> {}

export const auditEmitter = new AuditEmitter();
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/audit/emitter.test.ts`
Expected: PASS

**Step 5: Delete old audit logger**

Delete `src/audit/logger.ts` and `tests/audit/logger.test.ts`.

**Step 6: Commit**

```bash
git add src/audit/emitter.ts tests/audit/emitter.test.ts
git rm src/audit/logger.ts tests/audit/logger.test.ts
git commit -m "feat: replace audit DB logger with EventEmitter"
```

---

### Task 2: Create SessionStore

The core replacement for all PostgreSQL session and approval state.

**Files:**
- Create: `src/session/store.ts`
- Create: `tests/session/store.test.ts`

**Step 1: Write the failing tests**

Create `tests/session/store.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionStore } from "../../src/session/store.js";

describe("SessionStore", () => {
  let store: SessionStore;
  let mockRedis: Record<string, ReturnType<typeof vi.fn>>;
  let mockSlackClient: Record<string, ReturnType<typeof vi.fn>>;
  let firstMessageTs: string;

  beforeEach(() => {
    firstMessageTs = "1773820000.000000";
    mockRedis = {
      set: vi.fn().mockResolvedValue("OK"),
      get: vi.fn().mockResolvedValue(null),
      hset: vi.fn().mockResolvedValue(1),
      hget: vi.fn().mockResolvedValue(null),
      hdel: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
    };
    mockSlackClient = {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: firstMessageTs }),
      updateMessage: vi.fn().mockResolvedValue({ ok: true }),
      conversationsHistory: vi.fn().mockResolvedValue({
        ok: true,
        messages: [],
      }),
    };
    store = new SessionStore({
      redis: mockRedis as any,
      slackClient: mockSlackClient as any,
      botUserId: "U0AK72J10GH",
      sessionTtl: 86400,
    });
  });

  describe("create", () => {
    it("stores session in Redis and posts first Slack message with metadata", async () => {
      const result = await store.create("sess-1", "C123", "1773818131.282199");

      expect(mockRedis.set).toHaveBeenCalledWith(
        "thread:C123:1773818131.282199",
        "sess-1",
      );
      expect(mockRedis.expire).toHaveBeenCalled();
      expect(mockSlackClient.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C123",
          thread_ts: "1773818131.282199",
          metadata: expect.objectContaining({
            event_type: "vandura_session",
            event_payload: expect.objectContaining({ sessionId: "sess-1" }),
          }),
        }),
      );
      expect(result.firstMessageTs).toBe(firstMessageTs);
    });
  });

  describe("resolve", () => {
    it("returns session ID from Redis on cache hit", async () => {
      mockRedis.get.mockResolvedValue("sess-1");
      const sessionId = await store.resolve("C123", "1773818131.282199");
      expect(sessionId).toBe("sess-1");
    });

    it("falls back to Slack thread metadata on Redis miss", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockSlackClient.conversationsHistory.mockResolvedValue({
        ok: true,
        messages: [
          {
            user: "U0AK72J10GH",
            ts: firstMessageTs,
            metadata: {
              event_type: "vandura_session",
              event_payload: { sessionId: "sess-1" },
            },
          },
        ],
      });

      const sessionId = await store.resolve("C123", "1773818131.282199");
      expect(sessionId).toBe("sess-1");
      // Should rehydrate Redis
      expect(mockRedis.set).toHaveBeenCalledWith(
        "thread:C123:1773818131.282199",
        "sess-1",
      );
    });

    it("returns null when no session found anywhere", async () => {
      mockRedis.get.mockResolvedValue(null);
      mockSlackClient.conversationsHistory.mockResolvedValue({
        ok: true,
        messages: [],
      });

      const sessionId = await store.resolve("C123", "1773818131.282199");
      expect(sessionId).toBeNull();
    });
  });

  describe("sandboxPath", () => {
    it("derives path from session ID", () => {
      const path = store.sandboxPath("sess-1");
      expect(path).toMatch(/\/sess-1$/);
    });
  });

  describe("pending approvals", () => {
    it("sets and gets a pending approval", async () => {
      const approval = {
        toolName: "db_write",
        tier: 3 as const,
        toolUseId: "tu-1",
        toolInput: { query: "DELETE FROM users" },
      };

      await store.setPendingApproval("sess-1", "C123", firstMessageTs, approval);

      // Verify Redis store
      expect(mockRedis.hset).toHaveBeenCalledWith(
        "session:sess-1",
        "pendingApproval",
        expect.any(String),
      );

      // Verify Slack metadata update
      expect(mockSlackClient.updateMessage).toHaveBeenCalled();

      // Mock Redis to return the stored approval
      mockRedis.hget.mockResolvedValue(JSON.stringify(approval));
      const result = await store.getPendingApproval("sess-1");
      expect(result).toEqual(approval);
    });

    it("resolves a pending approval", async () => {
      await store.resolvePendingApproval("sess-1", "C123", firstMessageTs, "allow", "U789");

      expect(mockRedis.hdel).toHaveBeenCalledWith("session:sess-1", "pendingApproval");
      expect(mockSlackClient.updateMessage).toHaveBeenCalled();
    });

    it("returns null when no pending approval", async () => {
      mockRedis.hget.mockResolvedValue(null);
      const result = await store.getPendingApproval("sess-1");
      expect(result).toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/session/store.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Create `src/session/store.ts`:

```typescript
import { join } from "node:path";
import type { Redis } from "ioredis";

export interface PendingApproval {
  toolName: string;
  tier: 1 | 2 | 3;
  toolUseId: string;
  toolInput: Record<string, unknown>;
}

/** Slim version stored in Slack metadata (no toolInput, stays under 16KB). */
interface PendingApprovalMeta {
  toolName: string;
  tier: number;
  toolUseId: string;
}

interface SlackClient {
  postMessage: (params: Record<string, unknown>) => Promise<{ ok: boolean; ts?: string }>;
  updateMessage: (params: Record<string, unknown>) => Promise<{ ok: boolean }>;
  conversationsHistory: (params: Record<string, unknown>) => Promise<{
    ok: boolean;
    messages: Array<{
      user?: string;
      ts: string;
      metadata?: { event_type: string; event_payload: Record<string, unknown> };
    }>;
  }>;
}

interface SessionStoreOptions {
  redis: Redis;
  slackClient: SlackClient;
  botUserId: string;
  sessionTtl?: number; // seconds, default 7 days
  sessionsDir?: string;
}

export class SessionStore {
  private redis: Redis;
  private slackClient: SlackClient;
  private botUserId: string;
  private sessionTtl: number;
  private sessionsDir: string;
  // Cache of firstMessageTs per session for Slack metadata updates
  private firstMessageTsCache = new Map<string, string>();

  constructor(options: SessionStoreOptions) {
    this.redis = options.redis;
    this.slackClient = options.slackClient;
    this.botUserId = options.botUserId;
    this.sessionTtl = options.sessionTtl ?? 7 * 86400;
    this.sessionsDir = options.sessionsDir ?? join(
      process.env.HOME || "/root",
      ".claude",
      "sessions",
    );
  }

  /** Create a session: store in Redis + post first Slack message with metadata. */
  async create(
    sessionId: string,
    channelId: string,
    threadTs: string,
  ): Promise<{ firstMessageTs: string }> {
    // Redis: thread → sessionId index
    await this.redis.set(`thread:${channelId}:${threadTs}`, sessionId);
    await this.redis.expire(`thread:${channelId}:${threadTs}`, this.sessionTtl);

    // Slack: post first message with metadata backup
    const result = await this.slackClient.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "On it \u{1F440}",
      metadata: {
        event_type: "vandura_session",
        event_payload: { sessionId, pendingApproval: null },
      },
    });

    const firstMessageTs = result.ts!;
    this.firstMessageTsCache.set(sessionId, firstMessageTs);

    return { firstMessageTs };
  }

  /** Resolve a session ID from thread coordinates. Redis first, Slack fallback. */
  async resolve(channelId: string, threadTs: string): Promise<string | null> {
    // Try Redis
    const sessionId = await this.redis.get(`thread:${channelId}:${threadTs}`);
    if (sessionId) return sessionId;

    // Fallback: read first bot message metadata from Slack thread
    const resp = await this.slackClient.conversationsHistory({
      channel: channelId,
      oldest: threadTs,
      inclusive: true,
      limit: 10,
    });

    if (!resp.ok) return null;

    for (const msg of resp.messages) {
      if (
        msg.user === this.botUserId &&
        msg.metadata?.event_type === "vandura_session"
      ) {
        const recovered = msg.metadata.event_payload.sessionId as string;
        // Rehydrate Redis
        await this.redis.set(`thread:${channelId}:${threadTs}`, recovered);
        await this.redis.expire(`thread:${channelId}:${threadTs}`, this.sessionTtl);
        this.firstMessageTsCache.set(recovered, msg.ts);

        // Rehydrate pending approval if present
        const pending = msg.metadata.event_payload.pendingApproval as PendingApprovalMeta | null;
        if (pending) {
          await this.redis.hset(
            `session:${recovered}`,
            "pendingApproval",
            JSON.stringify(pending),
          );
        }

        return recovered;
      }
    }

    return null;
  }

  /** Derive sandbox path from session ID. */
  sandboxPath(sessionId: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.sessionsDir, date, sessionId);
  }

  /** Store a pending approval for a session. */
  async setPendingApproval(
    sessionId: string,
    channelId: string,
    threadTs: string,
    approval: PendingApproval,
  ): Promise<void> {
    // Full approval in Redis (includes toolInput)
    await this.redis.hset(
      `session:${sessionId}`,
      "pendingApproval",
      JSON.stringify(approval),
    );

    // Slim metadata in Slack (no toolInput)
    const meta: PendingApprovalMeta = {
      toolName: approval.toolName,
      tier: approval.tier,
      toolUseId: approval.toolUseId,
    };
    await this.updateSlackMetadata(sessionId, channelId, threadTs, {
      sessionId,
      pendingApproval: meta,
    });
  }

  /** Get the current pending approval for a session. */
  async getPendingApproval(sessionId: string): Promise<PendingApproval | null> {
    const raw = await this.redis.hget(`session:${sessionId}`, "pendingApproval");
    return raw ? JSON.parse(raw) : null;
  }

  /** Resolve (clear) the pending approval. */
  async resolvePendingApproval(
    sessionId: string,
    channelId: string,
    threadTs: string,
    decision: "allow" | "deny",
    approverId: string,
  ): Promise<void> {
    await this.redis.hdel(`session:${sessionId}`, "pendingApproval");
    await this.updateSlackMetadata(sessionId, channelId, threadTs, {
      sessionId,
      pendingApproval: null,
    });
  }

  /** Update the first bot message's metadata in Slack. */
  private async updateSlackMetadata(
    sessionId: string,
    channelId: string,
    threadTs: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const ts = this.firstMessageTsCache.get(sessionId);
    if (!ts) return; // Can't update if we don't know the message ts

    await this.slackClient.updateMessage({
      channel: channelId,
      ts,
      metadata: {
        event_type: "vandura_session",
        event_payload: payload,
      },
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/session/store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/session/store.ts tests/session/store.test.ts
git commit -m "feat: add SessionStore with Redis + Slack metadata backup"
```

---

### Task 3: Wire PostToolUse hook to AuditEmitter

Replace the DB insert in the PostToolUse hook with an event emission.

**Files:**
- Modify: `src/hooks/post-tool-use.ts`
- Modify: `tests/hooks/post-tool-use.test.ts` (if exists, otherwise create)

**Step 1: Rewrite post-tool-use.ts**

Replace `src/hooks/post-tool-use.ts` entirely:

```typescript
import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { auditEmitter } from "../audit/emitter.js";

export const postToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const postInput = input as PostToolUseHookInput;

  auditEmitter.emit("tool_use", {
    sessionId: postInput.session_id,
    toolName: postInput.tool_name,
    toolInput: (postInput.tool_input as Record<string, unknown>) ?? {},
    toolOutput: (postInput.tool_response as Record<string, unknown>) ?? {},
    toolUseId: toolUseId ?? "",
    timestamp: new Date().toISOString(),
  });

  return {};
};
```

**Step 2: Update or create test**

Verify the hook emits an event instead of writing to DB.

**Step 3: Run tests**

Run: `npm test -- --run tests/hooks/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/hooks/post-tool-use.ts tests/hooks/
git commit -m "refactor: post-tool-use hook emits audit event instead of DB insert"
```

---

### Task 4: Wire PreToolUse hook and approval-notifier to SessionStore

Replace DB-backed approval functions with SessionStore calls. This requires passing the SessionStore instance into the hooks.

**Files:**
- Modify: `src/hooks/pre-tool-use.ts`
- Modify: `src/hooks/approval-notifier.ts`
- Modify: `src/agent/permissions.ts` — remove DB-backed approval functions, keep `getToolTier`, `getAllGuardrails`, `loadToolPolicies`

**Step 1: Remove DB approval functions from permissions.ts**

Delete `storePendingApproval`, `getPendingApproval`, `getResolvedApproval`, `resolvePendingApproval` and the `pool` import. Keep: `loadToolPolicies`, `getToolTier`, `getAllGuardrails`, `PendingApproval` type (or re-export from SessionStore).

**Step 2: Update pre-tool-use.ts**

The hook needs access to the SessionStore. Pass it via a factory function:

```typescript
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getToolTier } from "../agent/permissions.js";
import { auditEmitter } from "../audit/emitter.js";
import type { SessionStore } from "../session/store.js";
import { containsSensitiveData } from "../tools/memory.js";
import { env } from "../config/env.js";

export function isMemoryWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  memoryDir: string,
): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  const filePath = (toolInput.file_path as string) || "";
  const normalizedDir = memoryDir.endsWith("/") ? memoryDir : memoryDir + "/";
  return filePath.startsWith(normalizedDir);
}

export function shouldBlockMemoryWrite(
  toolInput: Record<string, unknown>,
): string | null {
  const content = (toolInput.content as string) || (toolInput.new_string as string) || "";
  if (containsSensitiveData(content)) {
    return "Content appears to contain sensitive data (API keys, tokens, passwords). Please redact before saving to memory.";
  }
  return null;
}

export function createPreToolUseHook(sessionStore: SessionStore): HookCallback {
  return async (input, toolUseId, context) => {
    const preInput = input as PreToolUseHookInput;
    const sessionId = preInput.session_id;
    const toolName = preInput.tool_name;
    const toolInput = (preInput.tool_input as Record<string, unknown>) ?? {};

    console.log(`[PreToolUse] Tool: ${toolName}, Session: ${sessionId}`);

    // Memory write guard
    if (isMemoryWrite(toolName, toolInput, env.VANDURA_MEMORY_DIR)) {
      const blockReason = shouldBlockMemoryWrite(toolInput);
      if (blockReason) {
        console.log(`[PreToolUse] Blocked memory write: sensitive data detected`);
        return { decision: "block" as const, reason: blockReason };
      }
      return {};
    }

    const tier = getToolTier(toolName);

    if (tier === 1) {
      console.log(`[PreToolUse] Tier 1 auto-allow: ${toolName}`);
      return {};
    }

    // Check for resolved approval in SessionStore
    // (For now, check if there's a pending approval that was resolved)
    // The approval flow posts to Slack and blocks; on retry the approval is resolved
    const pending = await sessionStore.getPendingApproval(sessionId);

    if (pending && pending.toolName === toolName) {
      // Still pending — block
      const reason = `Awaiting ${tier === 2 ? "initiator" : "checker"} approval for tool "${toolName}". Reply \`approve\` or \`deny\` in the thread to continue.`;
      return {
        decision: "block" as const,
        reason,
      };
    }

    // No pending approval for this tool — store one and notify
    console.log(`[PreToolUse] Tier ${tier} — requesting approval for ${toolName}`);

    const approval = {
      toolName,
      tier: tier as 1 | 2 | 3,
      toolUseId: toolUseId ?? "",
      toolInput,
    };

    // Note: channelId and threadTs need to be passed via context or resolved
    // The SessionStore needs session context — this will be set up in Task 6
    await sessionStore.setPendingApproval(sessionId, "", "", approval);

    auditEmitter.emit("approval_requested", {
      sessionId,
      toolName,
      tier,
      timestamp: new Date().toISOString(),
    });

    const reason = `Awaiting ${tier === 2 ? "initiator" : "checker"} approval for tool "${toolName}". Reply \`approve\` or \`deny\` in the thread to continue.`;

    return {
      decision: "block" as const,
      reason,
    };
  };
}
```

**Step 3: Update approval-notifier.ts**

Replace DB session lookup with SessionStore. The notifier posts the approval request to Slack — it no longer needs to query the DB for channel/thread info since the caller already has this context.

```typescript
import type { SessionStore } from "../session/store.js";

export function createApprovalNotifier(
  slackBotToken: string,
  sessionStore: SessionStore,
) {
  return async function postApprovalToSlack(
    sessionId: string,
    channelId: string,
    threadTs: string,
    approval: { toolName: string; tier: number; toolInput: Record<string, unknown> },
  ): Promise<void> {
    const tierLabel = approval.tier === 2 ? "Initiator" : "Checker";
    const text = [
      `🔒 *${tierLabel} approval required* for tool \`${approval.toolName}\``,
      `\`\`\`${JSON.stringify(approval.toolInput, null, 2).substring(0, 500)}\`\`\``,
      `Reply \`approve\` or \`deny\` in this thread.`,
    ].join("\n");

    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channelId,
        thread_ts: threadTs,
        text,
      }),
    });
  };
}
```

**Step 4: Run tests**

Run: `npm test -- --run tests/hooks/`
Expected: PASS (update existing tests to match new signatures)

**Step 5: Commit**

```bash
git add src/hooks/pre-tool-use.ts src/hooks/post-tool-use.ts src/hooks/approval-notifier.ts src/agent/permissions.ts
git commit -m "refactor: wire approval hooks to SessionStore, remove DB approval functions"
```

---

### Task 5: Update worker.ts to use SessionStore

Replace `createSession`, `getSession`, `updateSessionStatus` imports with SessionStore.

**Files:**
- Modify: `src/queue/worker.ts`
- Delete: `src/agent/session.ts`
- Delete: `tests/agent/session.test.ts`

**Step 1: Update worker.ts**

Replace session imports and usage:

```typescript
// Remove: import { createSession, getSession, updateSessionStatus } from "../agent/session.js";
// Add: import type { SessionStore } from "../session/store.js";
```

- `processStartSession`: Use `sessionStore.create()` instead of `createSession()`. Generate session ID with `crypto.randomUUID()`. Derive sandboxPath via `sessionStore.sandboxPath()`.
- `processContinueSession`: Use `sessionStore.resolve()` instead of `getSession()`. Derive sandboxPath.
- Remove `updateSessionStatus()` call — no status tracking in Redis needed.

The SessionStore instance needs to be injected into the worker, similar to how `slackClient` is injected today.

**Step 2: Delete old session module**

Delete `src/agent/session.ts` and `tests/agent/session.test.ts`.

**Step 3: Run tests**

Run: `npm test -- --run tests/queue/`
Expected: PASS

**Step 4: Commit**

```bash
git rm src/agent/session.ts tests/agent/session.test.ts
git add src/queue/worker.ts
git commit -m "refactor: worker uses SessionStore instead of DB sessions"
```

---

### Task 6: Update app.ts — remove all PostgreSQL wiring

The big integration task. Remove pool, migrations, legacy modules. Wire SessionStore.

**Files:**
- Modify: `src/app.ts`
- Modify: `src/health.ts`

**Step 1: Remove from app.ts**

- Remove imports: `createPool`, `runMigrations`, `setPool`, `ThreadManager`, `AuditLogger`
- Remove: pool initialization (lines 37-39)
- Remove: agent DB insert (lines 47-56)
- Remove: ThreadManager instantiation and all calls (lines 58, 100-101, 105, 123-163)
- Remove: AuditLogger instantiation and all calls (lines 59, 93-95, 282-285)
- Add: Create `SessionStore` with Redis client + Slack client
- Add: Pass SessionStore to worker via new `setSessionStore()` function
- Add: Pass SessionStore to hook factories (`createPreToolUseHook(sessionStore)`)
- Update: `sdk-runtime.ts` hooks config to use factory functions

**Step 2: Update health.ts**

Replace DB health check with Redis ping:

```typescript
// Remove: pool.query("SELECT 1")
// Add: redis.ping()
```

**Step 3: Run full test suite**

Run: `npm test -- --run`
Expected: PASS (some tests may need updating)

**Step 4: Commit**

```bash
git add src/app.ts src/health.ts
git commit -m "refactor: remove PostgreSQL from app.ts, wire SessionStore"
```

---

### Task 7: Delete database layer and legacy modules

Clean removal of all unused code.

**Files:**
- Delete: `src/db/pool.ts`
- Delete: `src/db/connection.ts`
- Delete: `src/db/migrate.ts`
- Delete: `src/db/migrations/` (entire directory)
- Delete: `tests/db/` (entire directory)
- Delete: `src/threads/manager.ts`
- Delete: `tests/threads/` (entire directory)
- Delete: `src/approval/engine.ts`
- Delete: `tests/approval/` (entire directory)
- Delete: `src/users/manager.ts`
- Delete: `tests/users/` (entire directory)
- Delete: `src/credentials/manager.ts`
- Delete: `tests/credentials/` (if exists)

**Step 1: Delete all files**

```bash
rm -rf src/db/ tests/db/
rm -rf src/threads/ tests/threads/
rm -rf src/approval/ tests/approval/
rm -rf src/users/ tests/users/
rm src/credentials/manager.ts
```

**Step 2: Verify no dangling imports**

Run: `npm run typecheck`
Expected: PASS — no broken imports

**Step 3: Run full test suite**

Run: `npm test -- --run`
Expected: PASS

**Step 4: Commit**

```bash
git rm -r src/db/ tests/db/ src/threads/ tests/threads/ src/approval/ tests/approval/ src/users/ tests/users/ src/credentials/manager.ts
git commit -m "chore: remove PostgreSQL layer and legacy modules"
```

---

### Task 8: Update Docker and environment config

Remove postgres from Docker Compose and clean up env.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.test.yml`
- Modify: `.env` (remove DATABASE_URL)
- Modify: `src/config/env.ts` (remove DATABASE_URL)

**Step 1: Remove postgres service from docker-compose.yml**

Remove the postgres service definition, its volume, and the `depends_on` postgres entry from the vandura service. Remove `DATABASE_URL` from environment section.

**Step 2: Remove postgres from docker-compose.test.yml**

Remove the postgres test service.

**Step 3: Update env.ts**

Remove `DATABASE_URL` from the env config. Keep `DB_TOOL_CONNECTION_URL` (it's the agent's target database, unrelated to app storage).

**Step 4: Run full test suite**

Run: `npm test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.test.yml src/config/env.ts
git commit -m "chore: remove PostgreSQL from Docker Compose and env config"
```

---

### Task 9: Update integration tests

Rewrite `tests/integration/permissions.test.ts` to work against Redis/SessionStore instead of PostgreSQL.

**Files:**
- Modify: `tests/integration/permissions.test.ts`

**Step 1: Rewrite test**

Replace TestContainers PostgreSQL with mock Redis (or ioredis-mock). Test the full approval flow through SessionStore.

**Step 2: Run full test suite**

Run: `npm test -- --run`
Expected: ALL PASS

**Step 3: Final verification**

Run: `npm run typecheck && npm run lint && npm test -- --run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/integration/permissions.test.ts
git commit -m "test: rewrite permissions integration test for Redis-backed SessionStore"
```

---

### Task 10: Smoke test with Docker

Build and run the full stack without PostgreSQL.

**Step 1: Build**

```bash
docker compose up -d --build
```

**Step 2: Verify**

- No postgres container running
- Redis + Minio + Vandura containers healthy
- Bot responds to @mention in Slack
- Session ID appears in first bot message metadata
- File export still works (DB_TOOL_CONNECTION_URL is separate)

**Step 3: Commit any fixes**

If any issues found, fix and commit.
