# Thread Engagement Tracking Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track a `botEngaged` flag per session so the bot ignores side conversations in threads and only responds when engaged or @mentioned.

**Architecture:** New `bot_engaged` boolean column on sessions table. Engagement check runs in the `onThreadMessage` handler in `app.ts` before any message processing (approvals, continue_session). Detection uses Slack mention format `<@USER_ID>` to determine if bot or others are mentioned.

**Tech Stack:** TypeScript, PostgreSQL, Vitest

---

### Task 1: Engagement Detection Utility + Tests

**Files:**
- Create: `src/slack/engagement.ts`
- Test: `tests/slack/engagement.test.ts`

**Step 1: Write the failing tests**

Create `tests/slack/engagement.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { analyzeEngagement, type EngagementAction } from "../../src/slack/engagement.js";

const BOT_ID = "U0AK72J10GH";

describe("analyzeEngagement", () => {
  describe("when currently engaged", () => {
    it("stays engaged when message mentions bot", () => {
      const result = analyzeEngagement({
        text: `<@${BOT_ID}> check this`,
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("disengages when message mentions another user but not bot", () => {
      const result = analyzeEngagement({
        text: "<@U999OTHER> can you look at this?",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: false, forward: false });
    });

    it("stays engaged when no mentions at all", () => {
      const result = analyzeEngagement({
        text: "here is some more context",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("stays engaged when message mentions both bot and others", () => {
      const result = analyzeEngagement({
        text: `<@${BOT_ID}> and <@U999OTHER> check this`,
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });
  });

  describe("when currently disengaged", () => {
    it("re-engages when message mentions bot", () => {
      const result = analyzeEngagement({
        text: `<@${BOT_ID}> come back`,
        botUserId: BOT_ID,
        currentlyEngaged: false,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("stays disengaged when message mentions another user", () => {
      const result = analyzeEngagement({
        text: "<@U999OTHER> what do you think?",
        botUserId: BOT_ID,
        currentlyEngaged: false,
      });
      expect(result).toEqual({ engaged: false, forward: false });
    });

    it("stays disengaged when no mentions", () => {
      const result = analyzeEngagement({
        text: "yeah I agree with that",
        botUserId: BOT_ID,
        currentlyEngaged: false,
      });
      expect(result).toEqual({ engaged: false, forward: false });
    });
  });

  describe("edge cases", () => {
    it("handles empty text", () => {
      const result = analyzeEngagement({
        text: "",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("handles null/undefined text", () => {
      const result = analyzeEngagement({
        text: undefined as unknown as string,
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });

    it("does not false-match user IDs embedded in URLs or text", () => {
      const result = analyzeEngagement({
        text: "check https://example.com/U999OTHER",
        botUserId: BOT_ID,
        currentlyEngaged: true,
      });
      expect(result).toEqual({ engaged: true, forward: true });
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/slack/engagement.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the utility**

Create `src/slack/engagement.ts`:

```typescript
export interface EngagementAction {
  /** New engagement state to persist */
  engaged: boolean;
  /** Whether to forward this message to the worker */
  forward: boolean;
}

interface AnalyzeParams {
  text: string;
  botUserId: string;
  currentlyEngaged: boolean;
}

/**
 * Determine engagement state and whether to forward a thread message.
 *
 * Rules:
 * - If message mentions bot → engage + forward
 * - If message mentions others (not bot) → disengage + skip
 * - If no mentions → keep current state, forward only if engaged
 */
export function analyzeEngagement(params: AnalyzeParams): EngagementAction {
  const text = params.text || "";
  const { botUserId, currentlyEngaged } = params;

  const hasBotMention = text.includes(`<@${botUserId}>`);
  const hasOtherMention = new RegExp(`<@(?!${botUserId})[A-Z0-9]+>`).test(text);

  // Bot mentioned → always engage and forward
  if (hasBotMention) {
    return { engaged: true, forward: true };
  }

  // Others mentioned (not bot) → disengage and skip
  if (hasOtherMention) {
    return { engaged: false, forward: false };
  }

  // No mentions → maintain current state
  return { engaged: currentlyEngaged, forward: currentlyEngaged };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack/engagement.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/slack/engagement.ts tests/slack/engagement.test.ts
git commit -m "feat: add thread engagement detection utility"
```

---

### Task 2: Database Migration — `bot_engaged` Column

**Files:**
- Create: `src/db/migrations/008_bot_engaged.sql`
- Modify: `src/agent/session.ts`
- Modify: `src/queue/types.ts`

**Step 1: Create the migration**

Create `src/db/migrations/008_bot_engaged.sql`:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS bot_engaged BOOLEAN DEFAULT true;
```

**Step 2: Add `botEngaged` to Session type**

In `src/queue/types.ts`, add to the `Session` interface:

```typescript
export interface Session {
  id: string;
  channelId: string;
  userId: string;
  threadTs: string | null;
  sandboxPath: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  initiatorSlackId?: string;
  checkerSlackId?: string;
  botEngaged: boolean;  // ← ADD
}
```

**Step 3: Update session.ts**

In `src/agent/session.ts`:

1. Update `SessionRow` interface to include `bot_engaged: boolean`
2. Update `rowToSession` to map it: `botEngaged: row.bot_engaged ?? true`
3. Add new function:

```typescript
/**
 * Update the bot engagement flag for a session
 */
export async function updateBotEngaged(
  sessionId: string,
  engaged: boolean
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET bot_engaged = $1, updated_at = NOW() WHERE id = $2`,
    [engaged, sessionId]
  );
}
```

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (existing session mocks may need `botEngaged: true` added)

**Step 5: Commit**

```bash
git add src/db/migrations/008_bot_engaged.sql src/agent/session.ts src/queue/types.ts
git commit -m "feat: add bot_engaged column to sessions table"
```

---

### Task 3: Wire Engagement Check into app.ts

**Files:**
- Modify: `src/app.ts`
- Modify: `src/slack/gateway.ts`

**Step 1: Pass botUserId to the thread message handler**

The `gateway.onThreadMessage` handler in `app.ts` needs the bot user ID. It's already available as `authResult.user_id` in app.ts. No gateway changes needed — the bot user ID is accessible in the closure.

**Step 2: Add engagement check to onThreadMessage in app.ts**

In `src/app.ts`, modify the `onThreadMessage` handler. Insert the engagement check **after** the task lookup but **before** any message processing:

```typescript
gateway.onThreadMessage(async ({ user, text, channel, thread_ts, say }) => {
  const task = await threadManager.findByThread(channel, thread_ts);
  if (!task) return;

  // --- ENGAGEMENT CHECK (new) ---
  const agentSession = await getSessionByThread(channel, thread_ts);
  if (agentSession && authResult.user_id) {
    const { analyzeEngagement } = await import("./slack/engagement.js");
    const { updateBotEngaged } = await import("./agent/session.js");

    const action = analyzeEngagement({
      text,
      botUserId: authResult.user_id,
      currentlyEngaged: agentSession.botEngaged,
    });

    // Persist state change if different
    if (action.engaged !== agentSession.botEngaged) {
      await updateBotEngaged(agentSession.id, action.engaged);
      if (!action.engaged) {
        console.log(`[Gateway] Bot disengaged in thread ${thread_ts} (other user mentioned)`);
      } else {
        console.log(`[Gateway] Bot re-engaged in thread ${thread_ts} (bot mentioned)`);
      }
    }

    // Skip processing if not forwarding
    if (!action.forward) {
      console.log(`[Gateway] Skipping message in thread ${thread_ts} (bot disengaged)`);
      return;
    }
  }
  // --- END ENGAGEMENT CHECK ---

  // Check if this is a task close command
  const taskLifecycle = new TaskLifecycle();
  const closeCommand = taskLifecycle.parseCommand(text);
  // ... rest of existing handler unchanged ...
```

Note: The `getSessionByThread` call that was previously at line 146 should be moved up to the engagement check, and the later `getSessionByThread` call removed (reuse `agentSession`).

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Manual test**

1. Start a thread with the bot
2. Post a message mentioning another user: `@someone what do you think?`
3. Verify bot stays quiet (check logs for "Bot disengaged")
4. Post another message without mentioning bot → bot should still be quiet
5. Mention the bot: `@Vandura come back` → bot should respond
6. Verify logs show "Bot re-engaged"

**Step 5: Commit**

```bash
git add src/app.ts
git commit -m "feat: wire thread engagement tracking into message handler"
```

---

### Task 4: Integration Test

**Files:**
- Create: `tests/slack/engagement-integration.test.ts`

**Step 1: Write integration test**

Create `tests/slack/engagement-integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { analyzeEngagement } from "../../src/slack/engagement.js";

const BOT = "UBOT123";

describe("engagement flow scenarios", () => {
  it("full conversation with side chat and re-engagement", () => {
    let engaged = true;

    // User talks to bot
    let action = analyzeEngagement({ text: `<@${BOT}> run a query`, botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
    engaged = action.engaged;

    // User follows up (no mention)
    action = analyzeEngagement({ text: "also check the logs", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
    engaged = action.engaged;

    // User tags a coworker
    action = analyzeEngagement({ text: "<@UCOWORKER> can you verify this?", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: false, forward: false });
    engaged = action.engaged;

    // Coworker replies (no mention)
    action = analyzeEngagement({ text: "yeah looks good to me", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: false, forward: false });
    engaged = action.engaged;

    // User re-engages bot
    action = analyzeEngagement({ text: `<@${BOT}> ok proceed`, botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
    engaged = action.engaged;

    // Bot stays engaged for follow-ups
    action = analyzeEngagement({ text: "and send me the results", botUserId: BOT, currentlyEngaged: engaged });
    expect(action).toEqual({ engaged: true, forward: true });
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/slack/engagement-integration.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/slack/engagement-integration.test.ts
git commit -m "test: add engagement flow integration test"
```
