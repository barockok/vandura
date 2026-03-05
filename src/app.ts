import { App } from "@slack/bolt";
import { env } from "./config/env.js";
import { createPool } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { loadToolPolicies, loadAgents } from "./config/loader.js";
import { SlackGateway } from "./slack/gateway.js";
import { SlackApprovalFlow } from "./slack/approval-flow.js";
import { ThreadManager } from "./threads/manager.js";
import { ApprovalEngine } from "./approval/engine.js";
import { AuditLogger } from "./audit/logger.js";
import { AgentRuntime, type ChatOptions } from "./agent/runtime.js";
import { ToolExecutor } from "./agent/tool-executor.js";
import { CheckerFlow } from "./slack/checker-flow.js";
import { TaskLifecycle } from "./slack/task-lifecycle.js";
import { PostgresTool } from "./tools/postgres.js";
import { StorageService } from "./storage/s3.js";
import { buildHealthCheck, startHealthServer } from "./health.js";
import type { ToolResult } from "./tools/types.js";
import path from "node:path";

interface PendingApproval {
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  tier: 2 | 3;
  taskId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (msg: any) => Promise<unknown>;

export async function createApp() {
  const configDir = path.join(process.cwd(), "config");
  const toolPolicies = await loadToolPolicies(path.join(configDir, "tool-policies.yml"));
  const agents = await loadAgents(path.join(configDir, "agents.yml"));

  const pool = createPool(env.DATABASE_URL);
  await runMigrations(pool);

  // Target DB pool for the Postgres tool (may differ from app DB)
  const toolDbPool = createPool(env.DB_TOOL_CONNECTION_URL);

  const agentConfig = agents[0];
  const agentRow = await pool.query(
    `INSERT INTO agents (name, role, tools, personality, system_prompt_extra, max_concurrent_tasks)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET role = $2, tools = $3
     RETURNING id`,
    [agentConfig.name, agentConfig.role, JSON.stringify(agentConfig.tools),
     agentConfig.personality ?? null, agentConfig.system_prompt_extra ?? null,
     agentConfig.max_concurrent_tasks]
  );
  const agentId: string = agentRow.rows[0].id;

  const threadManager = new ThreadManager(pool);
  const approvalEngine = new ApprovalEngine(pool, toolPolicies);
  const auditLogger = new AuditLogger(pool);
  const approvalFlow = new SlackApprovalFlow();
  const storage = new StorageService({
    endpoint: env.S3_ENDPOINT, accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET,
    region: env.S3_REGION, signedUrlExpiry: env.S3_SIGNED_URL_EXPIRY,
  });
  await storage.ensureBucket();

  const pgTool = new PostgresTool(toolDbPool);

  const slackApp = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
  });
  slackApp.error(async (error) => { console.error("[SLACK ERROR]", error); });
  const gateway = new SlackGateway(slackApp);

  const authResult = await slackApp.client.auth.test();
  if (authResult.user_id) gateway.setBotUserId(authResult.user_id);

  // State: active runtimes + pending approvals per thread
  const activeAgents = new Map<string, AgentRuntime>();
  const activeExecutors = new Map<string, ToolExecutor>();
  const pendingApprovals = new Map<string, PendingApproval>();
  const pendingCheckerNomination = new Set<string>();

  function formatDuration(start: Date, end: Date): string {
    const ms = end.getTime() - start.getTime();
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  // Helper: run agent chat with tools and handle approval flow
  async function runAgentChat(
    runtime: AgentRuntime,
    executor: ToolExecutor,
    task: { id: string; initiatorSlackId: string; checkerSlackId: string | null },
    userMessage: string,
    threadTs: string,
    say: SayFn,
  ): Promise<void> {
    const chatOptions: ChatOptions = {
      tools: [pgTool.definition()],
      toolExecutor: async (toolName, toolInput, toolUseId) => {
        const result = await executor.execute(toolName, toolInput, toolUseId);

        if (result.needsApproval && result.approvalId && result.tier) {
          await approvalFlow.postApprovalRequest({
            say,
            threadTs,
            approvalId: result.approvalId,
            toolName,
            toolInput,
            tier: result.tier as 2 | 3,
            initiatorSlackId: task.initiatorSlackId,
            checkerSlackId: task.checkerSlackId,
          });

          pendingApprovals.set(threadTs, {
            approvalId: result.approvalId,
            toolName,
            toolInput,
            toolUseId,
            tier: result.tier as 2 | 3,
            taskId: task.id,
          });

          return {
            output: `Approval requested (tier ${result.tier}). Waiting for ${result.approver} to approve or deny.`,
            isError: false,
          };
        }

        return result as ToolResult;
      },
    };

    const response = await runtime.chat(userMessage, chatOptions);
    await threadManager.addMessage(task.id, "assistant", response.text, {
      toolCalls: response.toolCalls,
    });

    // Upload large responses to S3
    if (response.text.length > 4000) {
      const { signedUrl } = await storage.upload({
        key: `${task.id}/response-${Date.now()}.txt`,
        content: Buffer.from(response.text),
        contentType: "text/plain",
      });
      const preview = response.text.slice(0, 500) + `...\n\n📎 Full response: ${signedUrl}`;
      await say({ text: preview, thread_ts: threadTs });
    } else {
      await say({ text: response.text, thread_ts: threadTs });
    }
  }

  // Handle @mentions — create new task thread
  gateway.onMention(async ({ user, text, channel, ts, say }) => {
    await auditLogger.log({
      action: "mention_received", actor: user, detail: { text, channel },
    });

    await say({ text: "I'm on it! Let me look into this...", thread_ts: ts });

    const task = await threadManager.createTask({
      slackThreadTs: ts, slackChannel: channel, agentId, initiatorSlackId: user,
    });

    const runtime = new AgentRuntime({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
      agentConfig, toolPolicies,
    });
    activeAgents.set(ts, runtime);

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
    });
    activeExecutors.set(ts, executor);

    const hasHighTierTools = Object.values(toolPolicies).some(p => p.tier === 3);
    if (hasHighTierTools) {
      const checkerFlow = new CheckerFlow();
      await say({ text: checkerFlow.buildNominationPrompt(), thread_ts: ts });
      pendingCheckerNomination.add(ts);
    }

    const cleanText = text.replace(/<@[^>]+>/g, "").trim();
    await threadManager.addMessage(task.id, "user", cleanText, null);

    try {
      await runAgentChat(runtime, executor, task, cleanText, ts, say);
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts: ts });
    }
  });

  // Handle thread replies — approval decisions or continued conversation
  gateway.onThreadMessage(async ({ user, text, channel, thread_ts, say }) => {
    const task = await threadManager.findByThread(channel, thread_ts);
    if (!task) return;

    // Check if this is a task close command
    const taskLifecycle = new TaskLifecycle();
    const closeCommand = taskLifecycle.parseCommand(text);
    if (closeCommand) {
      await threadManager.closeTask(task.id, closeCommand);
      activeAgents.delete(thread_ts);
      activeExecutors.delete(thread_ts);
      pendingApprovals.delete(thread_ts);
      pendingCheckerNomination.delete(thread_ts);

      const messages = await threadManager.getMessages(task.id);
      const toolCallCount = messages.filter(m => m.metadata?.toolCalls).length;
      const approvalCount = (await approvalEngine.getPendingByTask(task.id)).length;
      const duration = formatDuration(task.createdAt, new Date());

      const summary = taskLifecycle.buildSummary({
        taskId: task.id, status: closeCommand,
        messageCount: messages.length, toolCallCount,
        approvalCount, duration,
      });
      await say({ text: summary, thread_ts });
      return;
    }

    // Check if this is a checker nomination reply
    if (pendingCheckerNomination.has(thread_ts)) {
      const checkerFlow = new CheckerFlow();
      const checkerId = checkerFlow.extractCheckerFromReply(text);
      if (checkerId) {
        pendingCheckerNomination.delete(thread_ts);
        if (checkerId !== "skip") {
          await threadManager.setChecker(task.id, checkerId);
          await say({ text: `<@${checkerId}> set as checker for this task.`, thread_ts });
        } else {
          await say({ text: "No checker assigned. Tier 3 actions will require any channel member to approve.", thread_ts });
        }
        return;
      }
    }

    // Check if this is an approval decision
    const pending = pendingApprovals.get(thread_ts);
    if (pending) {
      const decision = approvalFlow.parseDecision(text);
      if (decision) {
        const canApprove = approvalFlow.canApprove({
          tier: pending.tier,
          userId: user,
          initiatorSlackId: task.initiatorSlackId,
          checkerSlackId: task.checkerSlackId,
        });

        if (!canApprove) {
          await say({
            text: pending.tier === 2
              ? `Only <@${task.initiatorSlackId}> can approve this (tier 2).`
              : `Only the checker can approve this (tier 3).`,
            thread_ts,
          });
          return;
        }

        await approvalEngine.resolve(pending.approvalId, decision, user);
        pendingApprovals.delete(thread_ts);

        if (decision === "rejected") {
          await say({ text: "❌ Action denied. The tool will not be executed.", thread_ts });
          await auditLogger.log({
            taskId: task.id, action: "approval_rejected", actor: user,
            detail: { toolName: pending.toolName, approvalId: pending.approvalId },
          });
          return;
        }

        // Approved — execute the tool
        await say({ text: "✅ Approved. Executing...", thread_ts });
        const executor = activeExecutors.get(thread_ts);
        if (!executor) return;

        const toolResult = await executor.executeApproved(
          pending.toolName, pending.toolInput, user,
        );

        const runtime = activeAgents.get(thread_ts);
        if (!runtime) return;

        try {
          const agentMsg = `Tool "${pending.toolName}" was approved and executed. Result: ${toolResult.output}`;
          await threadManager.addMessage(task.id, "user", agentMsg, { source: "approval_result" });
          await runAgentChat(runtime, executor, task, agentMsg, thread_ts, say);
        } catch (err) {
          const errorMsg = `Error after approval: ${err instanceof Error ? err.message : "unknown"}`;
          await say({ text: errorMsg, thread_ts });
        }
        return;
      }
    }

    // Regular conversation message
    const runtime = activeAgents.get(thread_ts);
    if (!runtime) return;

    const executor = activeExecutors.get(thread_ts);
    if (!executor) return;

    await threadManager.addMessage(task.id, "user", text, null);

    try {
      await runAgentChat(runtime, executor, task, text, thread_ts, say);
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts });
    }
  });

  const healthCheck = buildHealthCheck({ pool, storage });

  return {
    start: async () => {
      await gateway.start();
      startHealthServer(healthCheck);
    },
    pool, toolDbPool, gateway, threadManager,
    approvalEngine, auditLogger, storage, healthCheck,
  };
}
