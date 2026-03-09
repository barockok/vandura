# Hooks-Based Maker-Checker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move maker-checker approval flow from `canUseTool` callback into the `PreToolUse` hook, removing interrupt/resume complexity.

**Architecture:** PreToolUse hook checks tool tier, stores pending approvals, posts Slack approval requests, and returns deny. When user approves in Slack, a `continue_session` job resumes the conversation. On retry, the hook finds the resolved approval and allows the tool.

**Tech Stack:** TypeScript, Claude Agent SDK hooks, BullMQ, PostgreSQL, Slack Bolt

---

### Task 1: Rewrite PreToolUse hook with maker-checker logic

**Files:**
- Modify: `src/hooks/pre-tool-use.ts` (full rewrite)

**Step 1: Write the new PreToolUse hook**

Replace the entire file with:

```typescript
/**
 * PreToolUse Hook - Maker-Checker approval flow
 *
 * Checks tool tier from tool-policies.yml:
 * - Tier 1: Auto-allow (pass through)
 * - Tier 2/3: Check for resolved approval in DB.
 *   If approved → allow. If denied → deny.
 *   If no approval exists → store pending, post to Slack, deny.
 */

import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { getToolTier, storePendingApproval, getResolvedApproval } from "../agent/permissions.js";
import { postApprovalToSlack } from "./approval-notifier.js";

export const preToolUseHook: HookCallback = async (input, toolUseId, context) => {
  const preInput = input as PreToolUseHookInput;
  const sessionId = preInput.session_id;
  const toolName = preInput.tool_name;
  const toolInput = (preInput as unknown as { tool_input: Record<string, unknown> }).tool_input ?? {};

  console.log(`[PreToolUse] Tool: ${toolName}, Session: ${sessionId}`);

  const tier = getToolTier(toolName);

  // Tier 1: auto-allow
  if (tier === 1) {
    console.log(`[PreToolUse] Tier 1 auto-allow: ${toolName}`);
    return {};
  }

  // Tier 2/3: check for existing resolved approval
  const resolved = await getResolvedApproval(sessionId, toolName);

  if (resolved) {
    if (resolved.decision === "allow") {
      console.log(`[PreToolUse] Found approved approval for ${toolName}, allowing`);
      return {};
    }
    console.log(`[PreToolUse] Found denied approval for ${toolName}, denying`);
    return {
      permissionDecision: "deny",
      reason: `Tool "${toolName}" was denied by approver.`,
    };
  }

  // No resolved approval — store pending and notify Slack
  console.log(`[PreToolUse] Tier ${tier} — requesting approval for ${toolName}`);

  const approval = await storePendingApproval({
    sessionId,
    toolName,
    toolInput,
    toolUseId: toolUseId ?? "",
    tier: tier as 1 | 2 | 3,
  });

  await postApprovalToSlack(sessionId, approval);

  return {
    permissionDecision: "deny",
    reason: `Awaiting ${tier === 2 ? "initiator" : "checker"} approval for tool "${toolName}". Reply \`approve\` or \`deny\` in the thread to continue.`,
  };
};
```

**Step 2: Verify TypeScript compiles (will fail — missing functions)**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors about missing `getResolvedApproval` and `postApprovalToSlack`

**Step 3: Commit**

```bash
git add src/hooks/pre-tool-use.ts
git commit -m "feat: rewrite PreToolUse hook with maker-checker logic"
```

---

### Task 2: Add `getResolvedApproval` to permissions.ts

**Files:**
- Modify: `src/agent/permissions.ts`

**Step 1: Add the `getResolvedApproval` function**

Add after the existing `getPendingApproval` function (after line 184):

```typescript
/**
 * Get a resolved approval for a session and tool name.
 * Used by PreToolUse hook to check if a tool was already approved/denied.
 */
export async function getResolvedApproval(
  sessionId: string,
  toolName: string
): Promise<PendingApproval | null> {
  const result = await pool.query<{
    id: string;
    session_id: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_use_id: string;
    tier: number;
    requested_at: Date;
    resolved_at: Date | null;
    decision: string | null;
    approver_id: string | null;
  }>(
    `SELECT * FROM pending_approvals
     WHERE session_id = $1 AND tool_name = $2 AND resolved_at IS NOT NULL
     ORDER BY resolved_at DESC
     LIMIT 1`,
    [sessionId, toolName]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolUseId: row.tool_use_id,
    tier: row.tier,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    decision: row.decision as "allow" | "deny" | null,
    approverId: row.approver_id,
  };
}
```

**Step 2: Commit**

```bash
git add src/agent/permissions.ts
git commit -m "feat: add getResolvedApproval for hook-based approval lookup"
```

---

### Task 3: Create approval-notifier for Slack posting from hooks

**Files:**
- Create: `src/hooks/approval-notifier.ts`

**Step 1: Create the notifier**

The hook can't access the Slack Bolt app directly (hooks run in SDK context). Use the DB to look up the session's channel/thread, then post via the Slack Web API using the bot token from env.

```typescript
/**
 * Approval Notifier - Posts approval requests to Slack from hooks
 *
 * Hooks don't have access to the Slack Bolt app instance, so we use
 * the Slack Web API directly with the bot token.
 */

import { pool } from "../db/pool.js";
import type { PendingApproval } from "../queue/types.js";

/**
 * Post an approval request message to the Slack thread for a session
 */
export async function postApprovalToSlack(
  sessionId: string,
  approval: PendingApproval
): Promise<void> {
  // Look up session to get channel and thread
  const result = await pool.query<{
    channel_id: string;
    thread_ts: string | null;
  }>(
    `SELECT channel_id, thread_ts FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    console.error(`[ApprovalNotifier] Session ${sessionId} not found`);
    return;
  }

  const { channel_id, thread_ts } = result.rows[0];
  const botToken = process.env.SLACK_BOT_TOKEN;

  if (!botToken) {
    console.error(`[ApprovalNotifier] SLACK_BOT_TOKEN not set`);
    return;
  }

  const tierEmoji = approval.tier === 2 ? "⚠️" : "🔴";
  const tierLabel = approval.tier === 2 ? "Initiator Approval" : "Checker Approval Required";

  const inputSummary = JSON.stringify(approval.toolInput, null, 2);
  const truncatedInput = inputSummary.length > 500
    ? inputSummary.slice(0, 500) + "..."
    : inputSummary;

  const message = `${tierEmoji} *${tierLabel}*\n\nTool: \`${approval.toolName}\`\nInput:\n\`\`\`\n${truncatedInput}\n\`\`\`\n\nReply with \`approve\` or \`deny\` to continue.`;

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: channel_id,
        text: message,
        thread_ts: thread_ts ?? undefined,
        mrkdwn: true,
      }),
    });

    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      console.error(`[ApprovalNotifier] Slack API error: ${data.error}`);
    }
  } catch (error) {
    console.error(`[ApprovalNotifier] Failed to post approval request:`, error);
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to approval-notifier

**Step 3: Commit**

```bash
git add src/hooks/approval-notifier.ts
git commit -m "feat: add approval-notifier for Slack posting from hooks"
```

---

### Task 4: Remove canUseTool and interrupt/resume from sdk-runtime.ts

**Files:**
- Modify: `src/agent/sdk-runtime.ts`

**Step 1: Remove `ApprovalRequiredError` class**

Delete lines 46-51 (`class ApprovalRequiredError`).

**Step 2: Remove `canUseTool` from `createQueryOptions`**

In `createQueryOptions()`, the returned `queryOptions` object should NOT include `canUseTool`. No changes needed here since `canUseTool` is added in `runSession()`, not in `createQueryOptions()`.

**Step 3: Simplify `runSession`**

Replace the entire `runSession` function with:

```typescript
/**
 * Run an agent session using SDK query()
 */
export async function runSession(
  session: Session,
  userMessage: string,
  mcpConfig: LoadedMcpConfig,
  onMessage: MessageCallback,
  agentConfig?: AgentConfig
): Promise<SessionResult> {
  const options = createQueryOptions(session, mcpConfig, agentConfig);

  try {
    const queryResult = query({
      prompt: userMessage,
      options,
    });

    for await (const msg of queryResult) {
      const agentMessage = processSdkMessage(msg, session.id);
      if (agentMessage) {
        await onMessage(agentMessage);
      }
    }

    await onMessage({ type: "complete", sessionId: session.id });
    return { status: "completed" };
  } catch (error) {
    console.error(`[Runtime] Error in session ${session.id}:`, error);
    await onMessage({
      type: "error",
      content: error instanceof Error ? error.message : "Unknown error",
      sessionId: session.id,
    });
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
```

**Step 4: Remove `resumeSession` function entirely**

Delete the `resumeSession` function (lines 243-294).

**Step 5: Simplify `continueSession`**

Remove `onApprovalNeeded` parameter:

```typescript
/**
 * Continue a session with user input
 */
export async function continueSession(
  session: Session,
  userMessage: string,
  mcpConfig: LoadedMcpConfig,
  onMessage: MessageCallback,
  agentConfig?: AgentConfig
): Promise<SessionResult> {
  const options = createQueryOptions(session, mcpConfig, agentConfig, true);

  try {
    const queryResult = query({
      prompt: userMessage,
      options: {
        ...options,
        resume: session.id,
      },
    });

    for await (const msg of queryResult) {
      const agentMessage = processSdkMessage(msg, session.id);
      if (agentMessage) {
        await onMessage(agentMessage);
      }
    }

    await onMessage({ type: "complete", sessionId: session.id });
    return { status: "completed" };
  } catch (error) {
    console.error(`[Runtime] Error continuing session ${session.id}:`, error);
    await onMessage({
      type: "error",
      content: error instanceof Error ? error.message : "Unknown error",
      sessionId: session.id,
    });
    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
```

**Step 6: Remove `createPermissionHandler` function**

Delete the entire `createPermissionHandler` function (lines 193-238).

**Step 7: Simplify `createQueryOptions` signature**

Remove `onApprovalNeeded` parameter from `createQueryOptions`:

```typescript
export function createQueryOptions(
  session: Session,
  mcpConfig: LoadedMcpConfig,
  agentConfig?: AgentConfig,
  isResuming: boolean = false
): Options {
```

**Step 8: Clean up `SessionResult` type**

Remove `approval` and `toolUseId` fields:

```typescript
export interface SessionResult {
  status: "completed" | "error";
  error?: string;
}
```

**Step 9: Remove unused imports**

Remove `ApprovalCallback` type export (and its definition), `PendingApproval` import if unused, `getToolTier` import.

**Step 10: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: Errors in worker.ts and app.ts (they still reference removed APIs) — that's expected, fixed in next tasks.

**Step 11: Commit**

```bash
git add src/agent/sdk-runtime.ts
git commit -m "refactor: remove canUseTool and interrupt/resume from sdk-runtime"
```

---

### Task 5: Remove `approve_tool` job type and simplify worker

**Files:**
- Modify: `src/queue/types.ts`
- Modify: `src/queue/worker.ts`

**Step 1: Remove `approve_tool` from types.ts**

In `src/queue/types.ts`:
- Remove `"approve_tool"` from `JobName` union (line 9)
- Remove `ApproveToolJobData` interface (lines 41-47)
- Remove `ApproveToolJobData` from `JobData` union (line 55)

**Step 2: Simplify worker.ts**

In `src/queue/worker.ts`:

Remove these imports that are no longer needed:
- `resolvePendingApproval`, `getPendingApproval` from permissions
- `resumeSession` from sdk-runtime
- `ApprovalCallback` type

Remove `requestApproval` callback (lines 89-104).

Remove `processApproveTool` function entirely (lines 208-291).

Remove the `"approve_tool"` case from `processJob` switch (lines 307-308).

Update `processStartSession` — remove `requestApproval` from `runSession` call:

```typescript
const result = await runSession(
  session,
  message,
  mcpConfig,
  (msg) => sendToSlack(session, msg),
  agentCfg || undefined
);
```

Remove the `awaiting_approval` status update after runSession (lines 146-148) — sessions no longer go into `awaiting_approval` from start.

Update `processContinueSession` — remove `requestApproval`:

```typescript
const result = await continueSession(
  session,
  message,
  mcpConfig,
  (msg) => sendToSlack(session, msg),
  agentCfg || undefined
);
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors in app.ts (still references approve_tool) — fixed in next task.

**Step 4: Commit**

```bash
git add src/queue/types.ts src/queue/worker.ts
git commit -m "refactor: remove approve_tool job type and simplify worker"
```

---

### Task 6: Update app.ts approval flow to use continue_session

**Files:**
- Modify: `src/app.ts`

**Step 1: Update the approve/deny handlers in `onThreadMessage`**

Replace the approve handler (lines 150-165) with:

```typescript
if (lowerText === "approve" || lowerText === "approved" || lowerText === "yes") {
  if (!agentSession) {
    await say({ text: "No active session found for this thread.", thread_ts });
    return;
  }

  // Resolve the pending approval in DB
  const { resolvePendingApproval, getPendingApproval } = await import("./agent/permissions.js");
  const pendingApproval = await getPendingApproval(agentSession.id);
  if (!pendingApproval) {
    await say({ text: "No pending approval found for this session.", thread_ts });
    return;
  }

  await resolvePendingApproval(agentSession.id, "allow", user);
  await say({ text: `Approved. Resuming...`, thread_ts });

  // Continue the session — model will retry the tool, hook will find the resolved approval
  await queue.add("continue_session", {
    type: "continue_session" as const,
    timestamp: Date.now(),
    sessionId: agentSession.id,
    message: `Tool \`${pendingApproval.toolName}\` has been approved. Please proceed with the original request.`,
  });
  return;
}
```

Replace the deny handler (lines 167-182) with:

```typescript
if (lowerText === "deny" || lowerText === "denied" || lowerText === "no") {
  if (!agentSession) {
    await say({ text: "No active session found for this thread.", thread_ts });
    return;
  }

  const { resolvePendingApproval, getPendingApproval } = await import("./agent/permissions.js");
  const pendingApproval = await getPendingApproval(agentSession.id);
  if (!pendingApproval) {
    await say({ text: "No pending approval found for this session.", thread_ts });
    return;
  }

  await resolvePendingApproval(agentSession.id, "deny", user);
  await say({ text: `Denied. The agent will try an alternative approach.`, thread_ts });

  await queue.add("continue_session", {
    type: "continue_session" as const,
    timestamp: Date.now(),
    sessionId: agentSession.id,
    message: `Tool \`${pendingApproval.toolName}\` has been denied. Please use an alternative approach.`,
  });
  return;
}
```

**Step 2: Remove unused imports**

Remove `ApproveToolJobData` from any imports if present.

**Step 3: Verify full compilation**

Run: `npx tsc --noEmit`
Expected: Clean compilation, no errors.

**Step 4: Commit**

```bash
git add src/app.ts
git commit -m "refactor: approval flow uses continue_session instead of approve_tool"
```

---

### Task 7: Clean up permissions.ts — remove canUseTool callback

**Files:**
- Modify: `src/agent/permissions.ts`

**Step 1: Remove `SdkPermissionResult` interface** (lines 22-27)

**Step 2: Remove `createPermissionCallback` function** (lines 206-245)

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Clean compilation.

**Step 4: Commit**

```bash
git add src/agent/permissions.ts
git commit -m "refactor: remove SdkPermissionResult and createPermissionCallback"
```

---

### Task 8: Remove `awaiting_approval` session status

**Files:**
- Modify: `src/queue/types.ts`

**Step 1: Remove `awaiting_approval` from `SessionStatus`**

Sessions no longer enter this state. The model just gets a deny and the conversation continues.

```typescript
export type SessionStatus =
  | "active"
  | "completed"
  | "failed";
```

**Step 2: Search for any remaining references to `awaiting_approval`**

Run: `grep -r "awaiting_approval" src/`

Remove or update any remaining references.

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: Clean compilation.

**Step 4: Commit**

```bash
git add -u
git commit -m "refactor: remove awaiting_approval session status"
```

---

### Task 9: Run tests and fix any failures

**Step 1: Run the test suite**

Run: `npm test`

**Step 2: Fix any test failures**

Tests in `tests/agent/session.test.ts` and other files may reference removed APIs (`resumeSession`, `ApprovalRequiredError`, `approve_tool` job type, `canUseTool`, etc.). Update tests to match the new flow.

**Step 3: Verify all tests pass**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add -u
git commit -m "test: update tests for hooks-based maker-checker flow"
```

---

### Task 10: Verify end-to-end with `docker compose up`

**Step 1: Build and start**

Run: `docker compose up --build vandura`

**Step 2: Verify startup**

Expected logs:
- `[Worker] Started worker for queue: vandura`
- No Redis connection errors
- No TypeScript compilation errors

**Step 3: Manual test in Slack**

1. Mention the bot in Slack
2. Ask it to query a tier 2/3 tool (e.g. "show me the first 5 customers")
3. Verify the approval request appears with "Reply `approve` or `deny`" instructions
4. Reply `approve` — verify the model retries and succeeds
5. Test `deny` flow — verify the model tries an alternative

**Step 4: Commit any final fixes**

```bash
git add -u
git commit -m "fix: final adjustments for hooks-based maker-checker"
```
