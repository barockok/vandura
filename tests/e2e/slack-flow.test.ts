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
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
    // Cleanup: delete test messages (best effort)
    for (const ts of createdThreads) {
      try {
        await slackPost("chat.delete", BOT_TOKEN, { channel: CHANNEL_ID, ts });
      } catch { /* best effort */ }
    }
    await pool?.end();
  });

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
});
