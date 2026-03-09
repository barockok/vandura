import { App } from "@slack/bolt";
import path from "node:path";
import { AuditLogger } from "./audit/logger.js";
import { env } from "./config/env.js";
import { loadAgents, loadRoles, loadToolPolicies } from "./config/loader.js";
import type { RolePermission } from "./config/types.js";
import { createPool } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { setPool } from "./db/pool.js";
import { buildHealthCheck, startHealthServer } from "./health.js";
import { loadToolPolicies as loadToolPoliciesForWorker } from "./agent/permissions.js";
import { getSessionByThread } from "./agent/session.js";
import { PermissionService } from "./permissions/service.js";
import { SlackGateway } from "./slack/gateway.js";
import { OnboardingFlow } from "./slack/onboarding-flow.js";
import { createSlackResponder } from "./slack/responder.js";
import { TaskLifecycle } from "./slack/task-lifecycle.js";
import { ThreadManager } from "./threads/manager.js";
import { UserManager } from "./users/manager.js";
import { createQueue, closeQueue } from "./queue/index.js";
import { createWorker, closeWorker, setSlackClient } from "./queue/worker.js";
import type { Worker } from "bullmq";

export async function createApp() {
  const configDir = path.join(process.cwd(), "config");
  await loadToolPolicies(path.join(configDir, "tool-policies.yml"));
  const agents = await loadAgents(path.join(configDir, "agents.yml"));

  let roles: Record<string, RolePermission> = {};
  try {
    roles = await loadRoles(path.join(configDir, "roles.yml"));
  } catch {
    console.warn("[CONFIG] roles.yml not found — running without role-based permissions");
  }

  const pool = createPool(env.DATABASE_URL);
  setPool(pool); // Share pool with worker modules (session.ts, permissions.ts)
  await runMigrations(pool);

  const userManager = new UserManager(pool);
  const permissionService = new PermissionService(roles);
  const availableRoles = Object.keys(roles);
  const onboardingFlow = new OnboardingFlow(availableRoles);

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
  const auditLogger = new AuditLogger(pool);

  const slackApp = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
  });
  slackApp.error(async (error) => { console.error("[SLACK ERROR]", error); });
  const gateway = new SlackGateway(slackApp);

  const authResult = await slackApp.client.auth.test();
  if (authResult.user_id) gateway.setBotUserId(authResult.user_id);

  // Initialize queue and worker
  const queue = createQueue();
  const responder = createSlackResponder(slackApp);
  setSlackClient(responder);

  // Load tool policies for worker
  await loadToolPoliciesForWorker(path.join(configDir, "tool-policies.yml"));

  const pendingOnboarding = new Map<string, string>(); // DM channel → slack user ID

  function formatDuration(start: Date, end: Date): string {
    const ms = end.getTime() - start.getTime();
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  // Handle @mentions — queue a new session
  gateway.onMention(async ({ user, text, channel, ts, say }) => {
    await auditLogger.log({
      action: "mention_received", actor: user, detail: { text, channel },
    });

    await say({ text: "On it 👀", thread_ts: ts });

    // Create task for tracking
    const task = await threadManager.createTask({
      slackThreadTs: ts, slackChannel: channel, agentId, initiatorSlackId: user,
    });

    const cleanText = text.replace(/<@[^>]+>/g, "").trim();
    await threadManager.addMessage(task.id, "user", cleanText, null);

    // Queue a start_session job
    await queue.add("start_session", {
      type: "start_session" as const,
      timestamp: Date.now(),
      channelId: channel,
      userId: user,
      message: cleanText,
      threadTs: ts,
    });

    console.log(`[Gateway] Queued start_session for channel ${channel}, thread ${ts}`);
  });

  // Handle thread replies — queue a continue_session job or handle approvals
  gateway.onThreadMessage(async ({ user, text, channel, thread_ts, say }) => {
    const task = await threadManager.findByThread(channel, thread_ts);
    if (!task) return;

    // Check if this is a task close command
    const taskLifecycle = new TaskLifecycle();
    const closeCommand = taskLifecycle.parseCommand(text);
    if (closeCommand) {
      await threadManager.closeTask(task.id, closeCommand);

      const messages = await threadManager.getMessages(task.id);
      const toolCallCount = messages.filter(m => m.metadata?.toolCalls).length;
      const duration = formatDuration(task.createdAt, new Date());

      const closedTask = await threadManager.findByThread(channel, thread_ts);
      const summary = taskLifecycle.buildSummary({
        taskId: task.id, status: closeCommand,
        messageCount: messages.length, toolCallCount,
        approvalCount: 0, // TODO: Get from approvals table
        duration,
        inputTokens: closedTask?.inputTokens ?? 0,
        outputTokens: closedTask?.outputTokens ?? 0,
      });
      await say({ text: summary, thread_ts });
      return;
    }

    // Look up the agent session by thread
    const agentSession = await getSessionByThread(channel, thread_ts);

    // Check for approval/deny text
    const lowerText = text.toLowerCase().trim();
    if (lowerText === "approve" || lowerText === "approved" || lowerText === "yes") {
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

      await resolvePendingApproval(agentSession.id, "allow", user);
      await say({ text: `Approved. Resuming...`, thread_ts });

      await queue.add("continue_session", {
        type: "continue_session" as const,
        timestamp: Date.now(),
        sessionId: agentSession.id,
        message: `Tool \`${pendingApproval.toolName}\` has been approved. Please proceed with the original request.`,
      });
      return;
    }

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

    // Regular conversation message — queue continue_session
    await threadManager.addMessage(task.id, "user", text, null);

    if (!agentSession) {
      console.warn(`[Gateway] No agent session found for thread ${thread_ts}, skipping continue`);
      return;
    }

    await queue.add("continue_session", {
      type: "continue_session" as const,
      timestamp: Date.now(),
      sessionId: agentSession.id,
      message: text,
    });

    console.log(`[Gateway] Queued continue_session for thread ${thread_ts}`);
  });

  gateway.onMemberJoined(async ({ user, channel }) => {
    if (authResult.user_id && user === authResult.user_id) return;

    const existingUser = await userManager.findBySlackId(user);
    if (existingUser?.onboardedAt) return;

    if (availableRoles.length === 0) return;

    try {
      const dmResult = await slackApp.client.conversations.open({ users: user });
      if (!dmResult.ok || !dmResult.channel?.id) {
        console.error(`[ONBOARDING] Could not open DM with ${user}`);
        return;
      }

      pendingOnboarding.set(dmResult.channel.id, user);

      const welcomeMsg = onboardingFlow.buildWelcomeMessage(channel);
      await slackApp.client.chat.postMessage({
        channel: dmResult.channel.id,
        text: welcomeMsg,
      });

      await auditLogger.log({
        action: "onboarding_started", actor: user,
        detail: { channel, dmSent: true },
      });
    } catch (err) {
      console.error(`[ONBOARDING] Failed to DM user ${user}:`, err);
    }
  });

  slackApp.event("message", async ({ event }) => {
    const msg = event as unknown as Record<string, unknown>;
    const channelId = msg.channel as string;
    const userId = msg.user as string;
    const text = (msg.text as string) ?? "";

    if (!pendingOnboarding.has(channelId)) return;
    const pendingUserId = pendingOnboarding.get(channelId);
    if (pendingUserId !== userId) return;

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

    try {
      let displayName = userId;
      try {
        const userInfo = await slackApp.client.users.info({ user: userId });
        displayName = userInfo.user?.profile?.display_name
          || userInfo.user?.real_name
          || userId;
      } catch { /* use userId as fallback */ }

      const vanduraUser = await userManager.findOrCreate(userId, displayName, role);
      await userManager.markOnboarded(vanduraUser.id);
      pendingOnboarding.delete(channelId);

      const confirmMsg = onboardingFlow.buildConfirmationMessage(role);
      await slackApp.client.chat.postMessage({ channel: channelId, text: confirmMsg });

      await auditLogger.log({
        action: "onboarding_completed", actor: userId,
        detail: { role, userId: vanduraUser.id },
      });
    } catch (err) {
      console.error(`[ONBOARDING] Failed to complete onboarding for ${userId}:`, err);
      pendingOnboarding.delete(channelId);
    }
  });

  const healthCheck = buildHealthCheck({ pool });
  let healthServer: ReturnType<typeof startHealthServer> | null = null;
  let worker: Worker | null = null;

  return {
    start: async () => {
      // Start worker
      worker = createWorker();

      // Start Slack gateway
      await gateway.start();
      healthServer = startHealthServer(healthCheck);

      console.log("[App] Started worker and Slack gateway");
    },
    stop: async () => {
      console.log("Shutting down...");
      healthServer?.close();

      if (worker) {
        await closeWorker(worker);
      }

      await slackApp.stop();
      await closeQueue(queue);
      await pool.end();

      console.log("Shutdown complete.");
    },
    pool, gateway, threadManager,
    auditLogger, healthCheck,
    userManager, permissionService, onboardingFlow,
    queue, worker,
  };
}