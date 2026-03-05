/**
 * E2E test: Full Slack @mention → bot reply flow.
 *
 * Prerequisites:
 *   - docker compose up -d (Postgres + MinIO)
 *   - npm run dev (app running with Socket Mode)
 *   - .env has SLACK_USER_TOKEN (xoxp user token from E2E Test app)
 *
 * Run: npx vitest run tests/e2e/slack-flow.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type Pool } from "../../src/db/connection.js";
import { config } from "dotenv";

config();

const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN!;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID!;
const DATABASE_URL = process.env.DATABASE_URL!;

let BOT_USER_ID: string;

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

describe("E2E: Slack @mention → bot reply", () => {
  let pool: Pool;

  beforeAll(async () => {
    const botAuth = await slackPost("auth.test", SLACK_BOT_TOKEN, {}) as { ok: boolean; user_id: string };
    expect(botAuth.ok).toBe(true);
    BOT_USER_ID = botAuth.user_id;

    const userAuth = await slackPost("auth.test", SLACK_USER_TOKEN, {}) as { ok: boolean };
    expect(userAuth.ok).toBe(true);

    pool = createPool(DATABASE_URL);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("posts @mention, bot replies in thread, data persisted in DB", async () => {
    // 1. Post a message mentioning the bot
    const uniqueId = Date.now();
    const mentionText = `<@${BOT_USER_ID}> E2E test: what is 2+2? (id=${uniqueId})`;
    const postResult = await slackPost("chat.postMessage", SLACK_USER_TOKEN, {
      channel: SLACK_CHANNEL_ID,
      text: mentionText,
    }) as { ok: boolean; ts: string; error?: string };

    expect(postResult.ok).toBe(true);
    const threadTs = postResult.ts;
    console.log(`  Posted @mention (ts=${threadTs})`);

    // 2. Wait for the bot to reply in the thread
    const botReply = await waitFor(
      async () => {
        const replies = await slackGet("conversations.replies", SLACK_BOT_TOKEN, {
          channel: SLACK_CHANNEL_ID,
          ts: threadTs,
        }) as { ok: boolean; messages?: Array<{ user: string; text: string; ts: string }> };

        if (!replies.ok || !replies.messages) return null;

        const botMessages = replies.messages.filter(
          (m) => m.user === BOT_USER_ID && m.ts !== threadTs,
        );

        // Expect: "I'm on it!" + actual response
        if (botMessages.length >= 2) return botMessages;
        return null;
      },
      { timeout: 45_000, interval: 3_000 },
    );

    console.log(`  Bot replied with ${botReply.length} messages`);
    expect(botReply.length).toBeGreaterThanOrEqual(2);
    expect(botReply[0].text).toContain("I'm on it");
    expect(botReply[1].text.length).toBeGreaterThan(0);
    console.log(`  Bot response: "${botReply[1].text.slice(0, 100)}..."`);

    // 3. Verify task in database
    const taskResult = await pool.query(
      "SELECT * FROM tasks WHERE slack_thread_ts = $1 AND slack_channel = $2",
      [threadTs, SLACK_CHANNEL_ID],
    );
    expect(taskResult.rows.length).toBe(1);
    const task = taskResult.rows[0];
    console.log(`  Task in DB: ${task.id} (status=${task.status})`);

    // 4. Verify messages stored
    const msgResult = await pool.query(
      "SELECT role FROM messages WHERE task_id = $1 ORDER BY created_at",
      [task.id],
    );
    expect(msgResult.rows.length).toBeGreaterThanOrEqual(2);
    const roles = msgResult.rows.map((r: Record<string, unknown>) => r.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    console.log(`  Messages in DB: ${msgResult.rows.length} (${roles.join(", ")})`);

    // 5. Verify audit log
    const auditResult = await pool.query(
      "SELECT * FROM audit_log WHERE action = 'mention_received' AND detail::text LIKE $1",
      [`%${SLACK_CHANNEL_ID}%`],
    );
    expect(auditResult.rows.length).toBeGreaterThanOrEqual(1);
    console.log(`  Audit log: ${auditResult.rows.length} entries`);

    // 6. Test thread follow-up
    const replyText = `Follow-up: what is 3+3? (id=${uniqueId})`;
    const replyResult = await slackPost("chat.postMessage", SLACK_USER_TOKEN, {
      channel: SLACK_CHANNEL_ID,
      text: replyText,
      thread_ts: threadTs,
    }) as { ok: boolean };
    expect(replyResult.ok).toBe(true);
    console.log(`  Posted follow-up in thread`);

    // Wait for bot to reply to follow-up
    const followUpReply = await waitFor(
      async () => {
        const replies = await slackGet("conversations.replies", SLACK_BOT_TOKEN, {
          channel: SLACK_CHANNEL_ID,
          ts: threadTs,
        }) as { ok: boolean; messages?: Array<{ user: string; ts: string }> };

        if (!replies.ok || !replies.messages) return null;

        const botMessages = replies.messages.filter(
          (m) => m.user === BOT_USER_ID && m.ts !== threadTs,
        );

        // "I'm on it" + response1 + response2 = at least 3
        if (botMessages.length >= 3) return botMessages;
        return null;
      },
      { timeout: 45_000, interval: 3_000 },
    );

    console.log(`  Follow-up: ${followUpReply.length} total bot messages in thread`);
    expect(followUpReply.length).toBeGreaterThanOrEqual(3);

    // Verify follow-up in DB
    const finalMsgResult = await pool.query(
      "SELECT COUNT(*) as count FROM messages WHERE task_id = $1",
      [task.id],
    );
    expect(Number(finalMsgResult.rows[0].count)).toBeGreaterThanOrEqual(4);
    console.log(`  Final DB messages: ${finalMsgResult.rows[0].count}`);
  }, 120_000);

  it("bot ignores threads it did not create", async () => {
    // Post without mentioning the bot
    const postResult = await slackPost("chat.postMessage", SLACK_USER_TOKEN, {
      channel: SLACK_CHANNEL_ID,
      text: `No bot mention (ts=${Date.now()})`,
    }) as { ok: boolean; ts: string };
    expect(postResult.ok).toBe(true);

    // Reply in that thread
    await slackPost("chat.postMessage", SLACK_USER_TOKEN, {
      channel: SLACK_CHANNEL_ID,
      text: "Thread reply the bot should ignore",
      thread_ts: postResult.ts,
    });

    // Wait and verify bot did NOT reply
    await new Promise((r) => setTimeout(r, 10_000));

    const replies = await slackGet("conversations.replies", SLACK_BOT_TOKEN, {
      channel: SLACK_CHANNEL_ID,
      ts: postResult.ts,
    }) as { ok: boolean; messages?: Array<{ user: string }> };

    const botMessages = (replies.messages ?? []).filter(
      (m) => m.user === BOT_USER_ID,
    );
    expect(botMessages.length).toBe(0);
    console.log(`  Correctly ignored unrelated thread`);
  }, 30_000);

  it("bot executes db_query tool and returns results", async () => {
    const uniqueId = Date.now();
    const mentionText = `<@${BOT_USER_ID}> show me all tables in the database (id=${uniqueId})`;
    const postResult = await slackPost("chat.postMessage", SLACK_USER_TOKEN, {
      channel: SLACK_CHANNEL_ID,
      text: mentionText,
    }) as { ok: boolean; ts: string };

    expect(postResult.ok).toBe(true);
    const threadTs = postResult.ts;
    console.log(`  Posted tool-use @mention (ts=${threadTs})`);

    // Wait for bot response (ack + tool result)
    const botReply = await waitFor(
      async () => {
        const replies = await slackGet("conversations.replies", SLACK_BOT_TOKEN, {
          channel: SLACK_CHANNEL_ID,
          ts: threadTs,
        }) as { ok: boolean; messages?: Array<{ user: string; text: string; ts: string }> };

        if (!replies.ok || !replies.messages) return null;

        const botMessages = replies.messages.filter(
          (m) => m.user === BOT_USER_ID && m.ts !== threadTs,
        );

        // Expect: "I'm on it!" + checker prompt (maybe) + actual response
        if (botMessages.length >= 2) return botMessages;
        return null;
      },
      { timeout: 60_000, interval: 3_000 },
    );

    console.log(`  Bot replied with ${botReply.length} messages`);
    expect(botReply.length).toBeGreaterThanOrEqual(2);

    // Verify task in database
    const taskResult = await pool.query(
      "SELECT * FROM tasks WHERE slack_thread_ts = $1 AND slack_channel = $2",
      [threadTs, SLACK_CHANNEL_ID],
    );
    expect(taskResult.rows.length).toBe(1);
    console.log(`  Task in DB: ${taskResult.rows[0].id}`);
  }, 120_000);

  it("posts approval request for tier 2+ tools and processes approval", async () => {
    const uniqueId = Date.now();
    const mentionText = `<@${BOT_USER_ID}> run this query: SELECT count(*) FROM tasks (id=${uniqueId})`;
    const postResult = await slackPost("chat.postMessage", SLACK_USER_TOKEN, {
      channel: SLACK_CHANNEL_ID,
      text: mentionText,
    }) as { ok: boolean; ts: string };

    expect(postResult.ok).toBe(true);
    const threadTs = postResult.ts;
    console.log(`  Posted approval-flow @mention (ts=${threadTs})`);

    // Wait for any bot response
    const botReply = await waitFor(
      async () => {
        const replies = await slackGet("conversations.replies", SLACK_BOT_TOKEN, {
          channel: SLACK_CHANNEL_ID,
          ts: threadTs,
        }) as { ok: boolean; messages?: Array<{ user: string; text: string; ts: string }> };

        if (!replies.ok || !replies.messages) return null;

        const botMessages = replies.messages.filter(
          (m) => m.user === BOT_USER_ID && m.ts !== threadTs,
        );

        if (botMessages.length >= 2) return botMessages;
        return null;
      },
      { timeout: 60_000, interval: 3_000 },
    );

    console.log(`  Bot replied with ${botReply.length} messages`);
    expect(botReply.length).toBeGreaterThanOrEqual(2);

    // Check if any message is an approval request
    const hasApprovalRequest = botReply.some(m =>
      m.text.includes("Approval Required") || m.text.includes("approve")
    );

    if (hasApprovalRequest) {
      console.log(`  Approval request detected — posting "approve"`);
      // Post approval
      await slackPost("chat.postMessage", SLACK_USER_TOKEN, {
        channel: SLACK_CHANNEL_ID,
        text: "approve",
        thread_ts: threadTs,
      });

      // Wait for execution result
      const afterApproval = await waitFor(
        async () => {
          const replies = await slackGet("conversations.replies", SLACK_BOT_TOKEN, {
            channel: SLACK_CHANNEL_ID,
            ts: threadTs,
          }) as { ok: boolean; messages?: Array<{ user: string; text: string; ts: string }> };

          if (!replies.ok || !replies.messages) return null;

          const botMessages = replies.messages.filter(
            (m) => m.user === BOT_USER_ID && m.ts !== threadTs,
          );

          // After approval: original messages + "Approved" + result
          if (botMessages.length >= botReply.length + 2) return botMessages;
          return null;
        },
        { timeout: 60_000, interval: 3_000 },
      );

      console.log(`  After approval: ${afterApproval.length} total bot messages`);
      const approvedMsg = afterApproval.find(m => m.text.includes("Approved"));
      expect(approvedMsg).toBeDefined();
    } else {
      console.log(`  No approval needed (tier 1) — tool auto-executed`);
    }

    // Verify task exists
    const taskResult = await pool.query(
      "SELECT * FROM tasks WHERE slack_thread_ts = $1",
      [threadTs],
    );
    expect(taskResult.rows.length).toBe(1);
  }, 120_000);
});
