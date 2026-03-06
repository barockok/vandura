# §9 Testing & CI/CD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add coverage reporting with CI badge, wire the manual E2E CI job, and add multi-user E2E tests for the maker-checker approval flow.

**Architecture:** Three independent workstreams: (1) coverage via `@vitest/coverage-v8` piped through CI, (2) E2E GitHub Actions job with `workflow_dispatch`, (3) new E2E test cases using two Slack users (initiator + checker) to exercise tier-3 flows.

**Tech Stack:** Vitest, @vitest/coverage-v8, GitHub Actions, Slack Web API (real tokens)

---

### Task 1: Add coverage dependency and config

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`

**Step 1: Install coverage dependency**

Run: `npm install -D @vitest/coverage-v8`

**Step 2: Add test:coverage script to package.json**

In `package.json`, add to `"scripts"`:

```json
"test:coverage": "vitest run --coverage"
```

**Step 3: Update vitest.config.ts with coverage config**

Replace the full file with:

```typescript
import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Auto-detect colima Docker socket for Testcontainers
const colimaSocket = join(homedir(), ".colima/default/docker.sock");
if (!process.env.DOCKER_HOST && existsSync(colimaSocket)) {
  process.env.DOCKER_HOST = `unix://${colimaSocket}`;
}
process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    exclude: ["tests/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
```

**Step 4: Run coverage locally to verify it works**

Run: `npm run test:coverage`
Expected: Tests pass, coverage summary printed to terminal, `coverage/` directory created.

**Step 5: Add coverage/ to .gitignore**

Append `coverage/` to `.gitignore`.

**Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts .gitignore
git commit -m "Add vitest coverage config with v8 provider"
```

---

### Task 2: Add coverage to CI and PR badge

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Step 1: Update CI test job to run coverage and post PR comment**

Replace the `test` job in `.github/workflows/ci.yml` with:

```yaml
  test:
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:coverage
      - name: Coverage report
        uses: davelosert/vitest-coverage-report-action@v2
        if: github.event_name == 'pull_request'
        with:
          json-summary-path: coverage/coverage-summary.json
          json-final-path: coverage/coverage-final.json
```

**Step 2: Add coverage badge to README.md**

After the opening `<div>` block (line 7), add:

```markdown

[![CI](https://github.com/barockok/vandura/actions/workflows/ci.yml/badge.svg)](https://github.com/barockok/vandura/actions/workflows/ci.yml)
```

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "Add coverage reporting to CI with PR comment action"
```

---

### Task 3: Wire E2E CI job with workflow_dispatch

**Files:**
- Modify: `.github/workflows/ci.yml`

**Step 1: Add workflow_dispatch trigger**

Update the `on:` block in `.github/workflows/ci.yml`:

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
```

**Step 2: Replace the commented e2e-slack job**

Remove the commented `# e2e-slack:` block and add this job after `build-and-push`:

```yaml
  e2e-slack:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: vandura_test
          POSTGRES_USER: vandura
          POSTGRES_PASSWORD: vandura
        options: >-
          --health-cmd "pg_isready -U vandura"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Run E2E tests
        run: npm run test:e2e:slack
        env:
          DATABASE_URL: postgres://vandura:vandura@localhost:5432/vandura_test
          DB_TOOL_CONNECTION_URL: postgres://vandura:vandura@localhost:5432/vandura_test
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ANTHROPIC_BASE_URL: ${{ secrets.ANTHROPIC_BASE_URL }}
          SLACK_APP_TOKEN: ${{ secrets.SLACK_APP_TOKEN }}
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
          SLACK_CHANNEL_ID: ${{ secrets.SLACK_CHANNEL_ID }}
          SLACK_USER_TOKEN: ${{ secrets.SLACK_USER_TOKEN }}
          E2E_INITIATOR_TOKEN: ${{ secrets.E2E_INITIATOR_TOKEN }}
          E2E_INITIATOR_REFRESH_TOKEN: ${{ secrets.E2E_INITIATOR_REFRESH_TOKEN }}
          E2E_CHECKER_TOKEN: ${{ secrets.E2E_CHECKER_TOKEN }}
          E2E_CHECKER_REFRESH_TOKEN: ${{ secrets.E2E_CHECKER_REFRESH_TOKEN }}
          KMS_PROVIDER: local
          S3_ENDPOINT: ""
          S3_ACCESS_KEY: ""
          S3_SECRET_KEY: ""
          S3_BUCKET: ""
          S3_REGION: us-east-1
```

Note: E2E tests run against a live Slack workspace with a live Vandura instance (started by `npm run dev` or as part of the test). The Postgres service container provides the database. S3/MinIO is not needed for the E2E Slack flow tests.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "Wire E2E Slack job with workflow_dispatch trigger"
```

---

### Task 4: Refactor E2E test helpers for multi-user

**Files:**
- Modify: `tests/e2e/slack-flow.test.ts`

**Step 1: Update env vars and user setup in beforeAll**

Replace the top section (lines 1-77) of `tests/e2e/slack-flow.test.ts` with:

```typescript
/**
 * E2E test: Full Slack @mention → bot reply flow with multi-user approval.
 *
 * Prerequisites:
 *   - docker compose up -d (Postgres + MinIO)
 *   - npm run dev (app running with Socket Mode)
 *   - .env has E2E_INITIATOR_TOKEN, E2E_CHECKER_TOKEN
 *
 * Run: npx vitest run tests/e2e/slack-flow.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createPool, type Pool } from "../../src/db/connection.js";
import { config } from "dotenv";

config();

// Tokens
const INITIATOR_TOKEN = process.env.E2E_INITIATOR_TOKEN || process.env.SLACK_USER_TOKEN!;
const CHECKER_TOKEN = process.env.E2E_CHECKER_TOKEN!;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID!;
const DATABASE_URL = process.env.DATABASE_URL!;

let BOT_USER_ID: string;
let INITIATOR_USER_ID: string;
let CHECKER_USER_ID: string;

// Track threads for cleanup
const createdThreads: string[] = [];

async function slackGet(
  method: string,
  token: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await resp.json()) as Record<string, unknown>;
}

async function slackPost(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as Record<string, unknown>;
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  { timeout = 30_000, interval = 3_000 } = {},
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}

function getBotMessages(
  messages: Array<{ user: string; ts: string }>,
  threadTs: string,
) {
  return messages.filter((m) => m.user === BOT_USER_ID && m.ts !== threadTs);
}

async function fetchBotReplies(threadTs: string, minCount: number, timeout = 60_000) {
  return waitFor(
    async () => {
      const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
        channel: CHANNEL_ID,
        ts: threadTs,
      })) as {
        ok: boolean;
        messages?: Array<{ user: string; text: string; ts: string }>;
      };
      if (!replies.ok || !replies.messages) return null;
      const bot = getBotMessages(replies.messages, threadTs);
      return bot.length >= minCount ? bot : null;
    },
    { timeout, interval: 3_000 },
  );
}

describe("E2E: Slack multi-user flows", () => {
  let pool: Pool;

  beforeAll(async () => {
    // Verify all three tokens work
    const [botAuth, initiatorAuth, checkerAuth] = await Promise.all([
      slackPost("auth.test", BOT_TOKEN, {}) as Promise<{ ok: boolean; user_id: string }>,
      slackPost("auth.test", INITIATOR_TOKEN, {}) as Promise<{ ok: boolean; user_id: string }>,
      slackPost("auth.test", CHECKER_TOKEN, {}) as Promise<{ ok: boolean; user_id: string }>,
    ]);

    expect(botAuth.ok).toBe(true);
    expect(initiatorAuth.ok).toBe(true);
    expect(checkerAuth.ok).toBe(true);

    BOT_USER_ID = botAuth.user_id;
    INITIATOR_USER_ID = initiatorAuth.user_id;
    CHECKER_USER_ID = checkerAuth.user_id;

    console.log(`  Bot: ${BOT_USER_ID}, Initiator: ${INITIATOR_USER_ID}, Checker: ${CHECKER_USER_ID}`);

    pool = createPool(DATABASE_URL);
  });

  afterAll(async () => {
    // Cleanup: delete test messages
    for (const ts of createdThreads) {
      try {
        await slackPost("chat.delete", BOT_TOKEN, { channel: CHANNEL_ID, ts });
      } catch { /* best effort */ }
    }
    await pool?.end();
  });
```

This sets up three users (bot, initiator, checker), shared helpers, and cleanup tracking.

**Step 2: Run to verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```bash
git add tests/e2e/slack-flow.test.ts
git commit -m "Refactor E2E tests for multi-user setup with cleanup"
```

---

### Task 5: Rewrite existing E2E tests with new helpers

**Files:**
- Modify: `tests/e2e/slack-flow.test.ts`

**Step 1: Add the existing test scenarios using the new multi-user structure**

After the `afterAll` block, add:

```typescript
  it("initiator mentions bot, bot replies in thread, DB persisted", async () => {
    const uid = Date.now();
    const post = (await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: `<@${BOT_USER_ID}> E2E: what is 2+2? (id=${uid})`,
    })) as { ok: boolean; ts: string };
    expect(post.ok).toBe(true);
    createdThreads.push(post.ts);

    const bot = await fetchBotReplies(post.ts, 2, 45_000);
    expect(bot.length).toBeGreaterThanOrEqual(2);
    expect(bot[0].text).toContain("On it");

    // DB check
    const task = await pool.query(
      "SELECT * FROM tasks WHERE slack_thread_ts = $1 AND slack_channel = $2",
      [post.ts, CHANNEL_ID],
    );
    expect(task.rows.length).toBe(1);
    console.log(`  Task ${task.rows[0].id} created`);
  }, 60_000);

  it("bot ignores threads it did not create", async () => {
    const post = (await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: `No bot mention (ts=${Date.now()})`,
    })) as { ok: boolean; ts: string };
    expect(post.ok).toBe(true);
    createdThreads.push(post.ts);

    await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: "Reply bot should ignore",
      thread_ts: post.ts,
    });

    await new Promise((r) => setTimeout(r, 10_000));

    const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
      channel: CHANNEL_ID,
      ts: post.ts,
    })) as { ok: boolean; messages?: Array<{ user: string }> };

    const botMsgs = (replies.messages ?? []).filter((m) => m.user === BOT_USER_ID);
    expect(botMsgs.length).toBe(0);
  }, 30_000);

  it("bot executes db_query tool (tier 1 auto-execute)", async () => {
    const post = (await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: `<@${BOT_USER_ID}> show me all tables in the database (id=${Date.now()})`,
    })) as { ok: boolean; ts: string };
    expect(post.ok).toBe(true);
    createdThreads.push(post.ts);

    const bot = await fetchBotReplies(post.ts, 2);
    expect(bot.length).toBeGreaterThanOrEqual(2);

    const task = await pool.query(
      "SELECT * FROM tasks WHERE slack_thread_ts = $1",
      [post.ts],
    );
    expect(task.rows.length).toBe(1);
  }, 120_000);
```

**Step 2: Verify tests still compile**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add tests/e2e/slack-flow.test.ts
git commit -m "Rewrite existing E2E scenarios with multi-user helpers"
```

---

### Task 6: Add tier-3 maker-checker E2E tests

**Files:**
- Modify: `tests/e2e/slack-flow.test.ts`

**Step 1: Add tier-3 approval test (checker approves)**

After the existing tests, add:

```typescript
  it("tier-3: checker approves, tool executes", async () => {
    // Initiator requests a tier-3 action (db_write triggers tier 3)
    const post = (await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: `<@${BOT_USER_ID}> create a table called e2e_test_${Date.now()} with one column "name" varchar(100) (id=${Date.now()})`,
    })) as { ok: boolean; ts: string };
    expect(post.ok).toBe(true);
    createdThreads.push(post.ts);

    // Wait for bot to post approval request
    const approvalMsg = await waitFor(
      async () => {
        const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
          channel: CHANNEL_ID,
          ts: post.ts,
        })) as { ok: boolean; messages?: Array<{ user: string; text: string; ts: string }> };
        if (!replies.ok || !replies.messages) return null;
        const bot = getBotMessages(replies.messages, post.ts);
        const approval = bot.find(
          (m) => m.text.includes("Approval Required") || m.text.includes("approve"),
        );
        return approval ?? null;
      },
      { timeout: 60_000 },
    );
    expect(approvalMsg).toBeDefined();
    console.log(`  Approval request posted`);

    // If checker nomination is requested, nominate checker
    const allReplies = (await slackGet("conversations.replies", BOT_TOKEN, {
      channel: CHANNEL_ID,
      ts: post.ts,
    })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };

    const needsChecker = allReplies.messages?.some(
      (m) => m.user === BOT_USER_ID && m.text.includes("checker"),
    );
    if (needsChecker) {
      await slackPost("chat.postMessage", INITIATOR_TOKEN, {
        channel: CHANNEL_ID,
        text: `<@${CHECKER_USER_ID}>`,
        thread_ts: post.ts,
      });
      // Wait for checker confirmation
      await new Promise((r) => setTimeout(r, 3_000));
    }

    // Checker approves
    await slackPost("chat.postMessage", CHECKER_TOKEN, {
      channel: CHANNEL_ID,
      text: "approve",
      thread_ts: post.ts,
    });

    // Wait for execution result
    const afterApproval = await waitFor(
      async () => {
        const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
          channel: CHANNEL_ID,
          ts: post.ts,
        })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };
        if (!replies.ok || !replies.messages) return null;
        const bot = getBotMessages(replies.messages, post.ts);
        const approved = bot.find((m) => m.text.includes("Approved"));
        return approved ? bot : null;
      },
      { timeout: 60_000 },
    );

    expect(afterApproval).toBeDefined();
    const hasApproved = afterApproval!.some((m) => m.text.includes("Approved"));
    expect(hasApproved).toBe(true);
    console.log(`  Checker approved, tool executed`);

    // Verify approval in DB
    const task = await pool.query(
      "SELECT id FROM tasks WHERE slack_thread_ts = $1",
      [post.ts],
    );
    const approvals = await pool.query(
      "SELECT * FROM approvals WHERE task_id = $1 AND status = 'approved'",
      [task.rows[0].id],
    );
    expect(approvals.rows.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
```

**Step 2: Add tier-3 rejection test (checker denies)**

```typescript
  it("tier-3: checker rejects, tool not executed", async () => {
    const post = (await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: `<@${BOT_USER_ID}> delete all rows from e2e_cleanup_${Date.now()} table (id=${Date.now()})`,
    })) as { ok: boolean; ts: string };
    expect(post.ok).toBe(true);
    createdThreads.push(post.ts);

    // Wait for approval request
    const approvalMsg = await waitFor(
      async () => {
        const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
          channel: CHANNEL_ID,
          ts: post.ts,
        })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };
        if (!replies.ok || !replies.messages) return null;
        const bot = getBotMessages(replies.messages, post.ts);
        return bot.find((m) => m.text.includes("Approval Required") || m.text.includes("approve")) ?? null;
      },
      { timeout: 60_000 },
    );
    expect(approvalMsg).toBeDefined();

    // Handle checker nomination if needed
    const allReplies = (await slackGet("conversations.replies", BOT_TOKEN, {
      channel: CHANNEL_ID,
      ts: post.ts,
    })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };

    if (allReplies.messages?.some((m) => m.user === BOT_USER_ID && m.text.includes("checker"))) {
      await slackPost("chat.postMessage", INITIATOR_TOKEN, {
        channel: CHANNEL_ID,
        text: `<@${CHECKER_USER_ID}>`,
        thread_ts: post.ts,
      });
      await new Promise((r) => setTimeout(r, 3_000));
    }

    // Checker denies
    await slackPost("chat.postMessage", CHECKER_TOKEN, {
      channel: CHANNEL_ID,
      text: "deny",
      thread_ts: post.ts,
    });

    // Wait for denial message
    const denialMsg = await waitFor(
      async () => {
        const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
          channel: CHANNEL_ID,
          ts: post.ts,
        })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };
        if (!replies.ok || !replies.messages) return null;
        const bot = getBotMessages(replies.messages, post.ts);
        return bot.find((m) => m.text.includes("denied") || m.text.includes("❌")) ?? null;
      },
      { timeout: 30_000 },
    );

    expect(denialMsg).toBeDefined();
    console.log(`  Checker denied, action blocked`);

    // Verify rejection in DB
    const task = await pool.query(
      "SELECT id FROM tasks WHERE slack_thread_ts = $1",
      [post.ts],
    );
    if (task.rows.length > 0) {
      const approvals = await pool.query(
        "SELECT * FROM approvals WHERE task_id = $1 AND status = 'rejected'",
        [task.rows[0].id],
      );
      expect(approvals.rows.length).toBeGreaterThanOrEqual(1);
    }
  }, 180_000);
```

**Step 3: Add self-approval denied test**

```typescript
  it("tier-3: initiator cannot self-approve", async () => {
    const post = (await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: `<@${BOT_USER_ID}> drop the e2e_selfapproval_${Date.now()} table if it exists (id=${Date.now()})`,
    })) as { ok: boolean; ts: string };
    expect(post.ok).toBe(true);
    createdThreads.push(post.ts);

    // Wait for approval request
    await waitFor(
      async () => {
        const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
          channel: CHANNEL_ID,
          ts: post.ts,
        })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };
        if (!replies.ok || !replies.messages) return null;
        const bot = getBotMessages(replies.messages, post.ts);
        return bot.find((m) => m.text.includes("Approval Required") || m.text.includes("approve")) ?? null;
      },
      { timeout: 60_000 },
    );

    // Handle checker nomination — skip it so any non-initiator can approve
    const allReplies = (await slackGet("conversations.replies", BOT_TOKEN, {
      channel: CHANNEL_ID,
      ts: post.ts,
    })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };

    if (allReplies.messages?.some((m) => m.user === BOT_USER_ID && m.text.includes("checker"))) {
      await slackPost("chat.postMessage", INITIATOR_TOKEN, {
        channel: CHANNEL_ID,
        text: "skip",
        thread_ts: post.ts,
      });
      await new Promise((r) => setTimeout(r, 3_000));
    }

    // Initiator tries to approve their own tier-3 request
    await slackPost("chat.postMessage", INITIATOR_TOKEN, {
      channel: CHANNEL_ID,
      text: "approve",
      thread_ts: post.ts,
    });

    // Wait for rejection message (bot should say only checker can approve)
    const rejectionMsg = await waitFor(
      async () => {
        const replies = (await slackGet("conversations.replies", BOT_TOKEN, {
          channel: CHANNEL_ID,
          ts: post.ts,
        })) as { ok: boolean; messages?: Array<{ user: string; text: string }> };
        if (!replies.ok || !replies.messages) return null;
        const bot = getBotMessages(replies.messages, post.ts);
        return bot.find((m) => m.text.includes("Only") && m.text.includes("checker")) ?? null;
      },
      { timeout: 30_000 },
    );

    expect(rejectionMsg).toBeDefined();
    console.log(`  Self-approval correctly rejected`);
  }, 180_000);

  // Close the describe block
});
```

**Step 4: Verify it compiles**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add tests/e2e/slack-flow.test.ts
git commit -m "Add tier-3 maker-checker E2E tests (approve, reject, self-approval denied)"
```

---

### Task 7: Add .gitignore entry for acessToken.txt

**Files:**
- Modify: `.gitignore`

The file `acessToken.txt` contains Slack tokens and should never be committed.

**Step 1: Add to .gitignore**

Append `acessToken.txt` to `.gitignore`.

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "Ignore acessToken.txt with Slack tokens"
```

---

### Task 8: Final verification and push

**Step 1: Run unit tests to make sure nothing broke**

Run: `npm test`
Expected: All 138+ tests pass.

**Step 2: Run coverage**

Run: `npm run test:coverage`
Expected: Tests pass, coverage report generated.

**Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: No errors.

**Step 4: Commit any remaining changes and push**

```bash
git push
```

**Step 5: Update project board**

Move §9 from "In Progress" to "In Review" in the GitHub Project.
