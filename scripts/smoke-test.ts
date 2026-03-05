/**
 * Smoke test: verifies all services are wired correctly against running docker-compose.
 * Run: npx tsx scripts/smoke-test.ts
 */
import { createPool } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";
import { ThreadManager } from "../src/threads/manager.js";
import { ApprovalEngine } from "../src/approval/engine.js";
import { AuditLogger } from "../src/audit/logger.js";
import { StorageService } from "../src/storage/s3.js";
import { AgentRuntime } from "../src/agent/runtime.js";
import { loadToolPolicies, loadAgents } from "../src/config/loader.js";
import path from "node:path";
import { config } from "dotenv";

config();

const pass = (msg: string) => console.log(`  ✅ ${msg}`);
const fail = (msg: string, err: unknown) => {
  console.log(`  ❌ ${msg}: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
};

async function main() {
  console.log("\n🔍 Vandura Smoke Test\n");

  // 1. Database connection
  const pool = createPool(process.env.DATABASE_URL!);
  try {
    const res = await pool.query("SELECT 1 as ok");
    if (res.rows[0].ok === 1) pass("Postgres connection");
    else fail("Postgres connection", "unexpected result");
  } catch (e) {
    fail("Postgres connection", e);
    return;
  }

  // 2. Migrations
  try {
    await runMigrations(pool);
    pass("Migrations applied");
  } catch (e) {
    fail("Migrations", e);
  }

  // 3. Config loading
  const configDir = path.join(process.cwd(), "config");
  let toolPolicies;
  let agents;
  try {
    toolPolicies = await loadToolPolicies(path.join(configDir, "tool-policies.yml"));
    agents = await loadAgents(path.join(configDir, "agents.yml"));
    pass(`Config loaded (${Object.keys(toolPolicies).length} policies, ${agents.length} agents)`);
  } catch (e) {
    fail("Config loading", e);
    return;
  }

  // 4. Agent seeding
  let agentId: string;
  try {
    const agentConfig = agents[0];
    const row = await pool.query(
      `INSERT INTO agents (name, role, tools, personality, system_prompt_extra, max_concurrent_tasks)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET role = $2, tools = $3
       RETURNING id`,
      [agentConfig.name, agentConfig.role, JSON.stringify(agentConfig.tools),
       agentConfig.personality ?? null, agentConfig.system_prompt_extra ?? null,
       agentConfig.max_concurrent_tasks]
    );
    agentId = row.rows[0].id;
    pass(`Agent seeded: ${agentConfig.name} (${agentId})`);
  } catch (e) {
    fail("Agent seeding", e);
    return;
  }

  // 5. Thread Manager — create task + messages
  const threadManager = new ThreadManager(pool);
  let taskId: string;
  try {
    const task = await threadManager.createTask({
      slackThreadTs: `smoke-${Date.now()}`,
      slackChannel: "C0AKND0UK4Y",
      agentId,
      initiatorSlackId: "U_SMOKE_TEST",
    });
    taskId = task.id;
    await threadManager.addMessage(taskId, "user", "Hello from smoke test", null);
    await threadManager.addMessage(taskId, "assistant", "Hello back!", null);
    const msgs = await threadManager.getMessages(taskId);
    if (msgs.length === 2) pass(`ThreadManager: task created, ${msgs.length} messages`);
    else fail("ThreadManager", `expected 2 messages, got ${msgs.length}`);
  } catch (e) {
    fail("ThreadManager", e);
    return;
  }

  // 6. Approval Engine — classify + request + resolve
  const approvalEngine = new ApprovalEngine(pool, toolPolicies);
  try {
    const c1 = approvalEngine.classify("mcp__gcs__upload", {});
    const c2 = approvalEngine.classify("unknown_tool", {});
    if (c1.tier === 1 && !c1.requiresApproval && c2.tier === 2 && c2.requiresApproval) {
      pass(`ApprovalEngine: classify works (gcs_upload=tier${c1.tier}, unknown=tier${c2.tier})`);
    } else {
      fail("ApprovalEngine classify", `gcs_upload: tier=${c1.tier} req=${c1.requiresApproval}, unknown: tier=${c2.tier} req=${c2.requiresApproval}`);
    }

    const approval = await approvalEngine.requestApproval(taskId!, "db_query", { sql: "SELECT 1" }, 2, "U_SMOKE_TEST");
    const resolved = await approvalEngine.resolve(approval.id, "approved", "U_CHECKER");
    if (resolved.status === "approved") pass("ApprovalEngine: request + resolve flow");
    else fail("ApprovalEngine resolve", `status=${resolved.status}`);
  } catch (e) {
    fail("ApprovalEngine", e);
  }

  // 7. Audit Logger
  const auditLogger = new AuditLogger(pool);
  try {
    await auditLogger.log({ action: "smoke_test", actor: "smoke", detail: { ts: Date.now() } });
    const logs = await auditLogger.getByActor("smoke");
    if (logs.length >= 1) pass("AuditLogger: log + query");
    else fail("AuditLogger", "no logs found");
  } catch (e) {
    fail("AuditLogger", e);
  }

  // 8. Storage (MinIO)
  const storage = new StorageService({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    accessKey: process.env.S3_ACCESS_KEY ?? "vandura",
    secretKey: process.env.S3_SECRET_KEY ?? "vandura123",
    bucket: process.env.S3_BUCKET ?? "vandura-results",
    region: process.env.S3_REGION ?? "us-east-1",
    signedUrlExpiry: 86400,
  });
  try {
    await storage.ensureBucket();
    const { key } = await storage.upload({ key: "smoke-test.txt", content: Buffer.from("hello vandura"), contentType: "text/plain" });
    const downloaded = await storage.download(key);
    if (downloaded.toString() === "hello vandura") pass(`Storage (MinIO): upload + download (key=${key})`);
    else fail("Storage", "content mismatch");
  } catch (e) {
    fail("Storage (MinIO)", e);
  }

  // 9. Agent Runtime — chat with Anthropic
  try {
    const runtime = new AgentRuntime({
      anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
      agentConfig: agents[0],
      toolPolicies,
    });
    const response = await runtime.chat("Say exactly: SMOKE_OK");
    if (response.length > 0) pass(`AgentRuntime: chat works (${response.length} chars)`);
    else fail("AgentRuntime", "empty response");
  } catch (e) {
    fail("AgentRuntime (Anthropic API)", e);
  }

  // 10. Slack Bot Token
  try {
    const resp = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    const data = await resp.json() as { ok: boolean; user?: string; error?: string };
    if (data.ok) pass(`Slack Bot: authenticated as "${data.user}"`);
    else fail("Slack Bot", data.error);
  } catch (e) {
    fail("Slack Bot", e);
  }

  // Cleanup
  try {
    await threadManager.closeTask(taskId!, "completed");
    await pool.query("DELETE FROM messages WHERE task_id = $1", [taskId]);
    await pool.query("DELETE FROM approvals WHERE task_id = $1", [taskId]);
    await pool.query("DELETE FROM tasks WHERE id = $1", [taskId]);
    await pool.query("DELETE FROM audit_log WHERE actor = 'smoke'");
  } catch { /* best effort */ }

  await pool.end();
  console.log("\n" + (process.exitCode ? "❌ Some checks failed" : "✅ All checks passed") + "\n");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
