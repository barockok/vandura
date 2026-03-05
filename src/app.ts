import { App } from "@slack/bolt";
import { env } from "./config/env.js";
import { createPool } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { loadToolPolicies, loadAgents } from "./config/loader.js";
import { SlackGateway } from "./slack/gateway.js";
import { ThreadManager } from "./threads/manager.js";
import { ApprovalEngine } from "./approval/engine.js";
import { AuditLogger } from "./audit/logger.js";
import { AgentRuntime } from "./agent/runtime.js";
import { StorageService } from "./storage/s3.js";
import path from "node:path";

export async function createApp() {
  // 1. Load config files from config/ directory
  const configDir = path.join(process.cwd(), "config");
  const toolPolicies = await loadToolPolicies(path.join(configDir, "tool-policies.yml"));
  const agents = await loadAgents(path.join(configDir, "agents.yml"));

  // 2. Set up database
  const pool = createPool(env.DATABASE_URL);
  await runMigrations(pool);

  // 3. Seed/upsert agents into the database
  const agentConfig = agents[0]; // v1: single agent
  const agentRow = await pool.query(
    `INSERT INTO agents (name, role, tools, personality, system_prompt_extra, max_concurrent_tasks)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET role = $2, tools = $3
     RETURNING id`,
    [
      agentConfig.name,
      agentConfig.role,
      JSON.stringify(agentConfig.tools),
      agentConfig.personality ?? null,
      agentConfig.system_prompt_extra ?? null,
      agentConfig.max_concurrent_tasks,
    ]
  );
  const agentId: string = agentRow.rows[0].id;

  // 4. Initialize services
  const threadManager = new ThreadManager(pool);
  const approvalEngine = new ApprovalEngine(pool, toolPolicies);
  const auditLogger = new AuditLogger(pool);
  const storage = new StorageService({
    endpoint: env.S3_ENDPOINT,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    signedUrlExpiry: env.S3_SIGNED_URL_EXPIRY,
  });
  await storage.ensureBucket();

  // 5. Set up Slack (Socket Mode)
  const slackApp = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
  });
  const gateway = new SlackGateway(slackApp);

  // 6. Active agent runtimes (keyed by thread_ts)
  const activeAgents = new Map<string, AgentRuntime>();

  // 7. Handle @mentions — create new task thread
  gateway.onMention(async ({ user, text, channel, ts, say }) => {
    await auditLogger.log({
      action: "mention_received",
      actor: user,
      detail: { text, channel },
    });

    // Reply in thread
    await say({ text: "I'm on it! Let me look into this...", thread_ts: ts });

    // Create task
    const task = await threadManager.createTask({
      slackThreadTs: ts,
      slackChannel: channel,
      agentId,
      initiatorSlackId: user,
    });

    // Create agent runtime
    const runtime = new AgentRuntime({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
      agentConfig,
      toolPolicies,
    });
    activeAgents.set(ts, runtime);

    // Process message
    const cleanText = text.replace(/<@[^>]+>/g, "").trim();
    await threadManager.addMessage(task.id, "user", cleanText, null);

    try {
      const response = await runtime.chat(cleanText);
      await threadManager.addMessage(task.id, "assistant", response, null);
      await say({ text: response, thread_ts: ts });
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts: ts });
    }
  });

  // 8. Handle thread replies — continue conversation
  gateway.onThreadMessage(async ({ text, channel, thread_ts, say }) => {
    const task = await threadManager.findByThread(channel, thread_ts);
    if (!task) return;

    const runtime = activeAgents.get(thread_ts);
    if (!runtime) return;

    await threadManager.addMessage(task.id, "user", text, null);

    try {
      const response = await runtime.chat(text);
      await threadManager.addMessage(task.id, "assistant", response, null);
      await say({ text: response, thread_ts: thread_ts });
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts: thread_ts });
    }
  });

  return {
    start: () => gateway.start(),
    pool,
    gateway,
    threadManager,
    approvalEngine,
    auditLogger,
    storage,
  };
}
