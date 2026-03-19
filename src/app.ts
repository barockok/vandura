import { App } from "@slack/bolt";
import crypto from "node:crypto";
import path from "node:path";
import { Redis } from "ioredis";
import { env } from "./config/env.js";
import { loadToolPolicies } from "./config/loader.js";
import { buildHealthCheck, startHealthServer } from "./health.js";
import { loadToolPolicies as loadToolPoliciesForWorker } from "./agent/permissions.js";
import { analyzeEngagement } from "./slack/engagement.js";
import { SlackGateway } from "./slack/gateway.js";
import { createSlackResponder } from "./slack/responder.js";
import { SessionStore } from "./session/store.js";
import { auditEmitter } from "./audit/emitter.js";
import { createQueue, closeQueue, getRedisOptions } from "./queue/index.js";
import { createWorker, closeWorker, setSlackClient, setSlackWebClient, setSessionStore } from "./queue/worker.js";
import type { Worker } from "bullmq";

export async function createApp() {
  // Wire audit events to stdout
  auditEmitter.on("tool_use", (e) => console.log(JSON.stringify({ audit: "tool_use", ...e })));
  auditEmitter.on("session_start", (e) => console.log(JSON.stringify({ audit: "session_start", ...e })));
  auditEmitter.on("approval_requested", (e) => console.log(JSON.stringify({ audit: "approval_requested", ...e })));
  auditEmitter.on("approval_resolved", (e) => console.log(JSON.stringify({ audit: "approval_resolved", ...e })));

  const configDir = path.join(process.cwd(), "config");
  await loadToolPolicies(path.join(configDir, "tool-policies.yml"));
  const slackApp = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
  });
  slackApp.error(async (error) => { console.error("[SLACK ERROR]", error); });
  const gateway = new SlackGateway(slackApp);

  const authResult = await slackApp.client.auth.test();
  if (authResult.user_id) gateway.setBotUserId(authResult.user_id);

  // Create Redis client (shared with BullMQ)
  const redis = new Redis(getRedisOptions());

  // Create SessionStore
  const sessionStore = new SessionStore({
    redis,
    slackClient: {
      postMessage: (params) => slackApp.client.chat.postMessage(params as any) as any,
      updateMessage: (params) => slackApp.client.chat.update(params as any) as any,
      conversationsReplies: (params) => slackApp.client.conversations.replies(params as any) as any,
    },
    botUserId: authResult.user_id || "",
  });

  // Inject SessionStore into worker
  setSessionStore(sessionStore);

  // Initialize queue and worker
  const queue = createQueue();
  const responder = createSlackResponder(slackApp);
  setSlackClient(responder);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSlackWebClient({ filesUploadV2: (params: any) => slackApp.client.files.uploadV2(params) });

  // Load tool policies for worker
  await loadToolPoliciesForWorker(path.join(configDir, "tool-policies.yml"));

  // Handle @mentions — queue a new session
  gateway.onMention(async ({ user, text, channel, ts, say, files }) => {
    const sessionId = crypto.randomUUID();

    // Post "On it" and store session mapping in Redis + Slack metadata
    await sessionStore.create(sessionId, channel, ts);

    auditEmitter.emit("session_start", {
      sessionId,
      channelId: channel,
      userId: user,
      timestamp: new Date(),
    });

    const cleanText = text.replace(/<@[^>]+>/g, "").trim();

    // Queue a start_session job
    await queue.add("start_session", {
      type: "start_session" as const,
      timestamp: Date.now(),
      sessionId,
      channelId: channel,
      userId: user,
      message: cleanText,
      threadTs: ts,
      files,
    });

    console.log(`[Gateway] Queued start_session for channel ${channel}, thread ${ts}`);
  });

  // Handle thread replies — queue a continue_session job or handle approvals
  gateway.onThreadMessage(async ({ user, text, channel, thread_ts, say, files }) => {
    const sessionId = await sessionStore.resolve(channel, thread_ts);
    if (!sessionId) return;

    // --- Engagement check ---
    if (authResult.user_id) {
      const currentlyEngaged = await sessionStore.isBotEngaged(sessionId);
      const action = analyzeEngagement({
        text,
        botUserId: authResult.user_id,
        currentlyEngaged,
      });

      if (action.engaged !== currentlyEngaged) {
        await sessionStore.setBotEngaged(sessionId, action.engaged);
        console.log(`[Gateway] Bot ${action.engaged ? "re-engaged" : "disengaged"} in thread ${thread_ts}`);
      }

      if (!action.forward) {
        console.log(`[Gateway] Skipping message in thread ${thread_ts} (bot disengaged)`);
        return;
      }
    }
    // --- End engagement check ---

    // Check for approval/deny text
    const lowerText = text.toLowerCase().trim();
    if (lowerText === "approve" || lowerText === "approved" || lowerText === "yes") {
      const pending = await sessionStore.getPendingApproval(sessionId);
      if (!pending) {
        // No hook-level approval — treat as regular continue (model asked via text, not hook)
        await queue.add("continue_session", {
          type: "continue_session" as const,
          timestamp: Date.now(),
          sessionId,
          channelId: channel,
          userId: user,
          threadTs: thread_ts,
          message: "The user has approved. Please proceed.",
        });
        return;
      }

      await sessionStore.resolvePendingApproval(sessionId, channel, thread_ts, "allow", user);
      auditEmitter.emit("approval_resolved", {
        sessionId,
        toolName: pending.toolName,
        decision: "allow",
        approverId: user,
        timestamp: new Date(),
      });
      await say({ text: `Approved. Resuming...`, thread_ts });

      await queue.add("continue_session", {
        type: "continue_session" as const,
        timestamp: Date.now(),
        sessionId,
        channelId: channel,
        userId: user,
        threadTs: thread_ts,
        message: `Tool \`${pending.toolName}\` has been approved. Please proceed with the original request.`,
      });
      return;
    }

    if (lowerText === "deny" || lowerText === "denied" || lowerText === "no") {
      const pending = await sessionStore.getPendingApproval(sessionId);
      if (!pending) {
        // No hook-level approval — treat as regular continue
        await queue.add("continue_session", {
          type: "continue_session" as const,
          timestamp: Date.now(),
          sessionId,
          channelId: channel,
          userId: user,
          threadTs: thread_ts,
          message: "The user has denied the request. Please use an alternative approach.",
        });
        return;
      }

      await sessionStore.resolvePendingApproval(sessionId, channel, thread_ts, "deny", user);
      auditEmitter.emit("approval_resolved", {
        sessionId,
        toolName: pending.toolName,
        decision: "deny",
        approverId: user,
        timestamp: new Date(),
      });
      await say({ text: `Denied. The agent will try an alternative approach.`, thread_ts });

      await queue.add("continue_session", {
        type: "continue_session" as const,
        timestamp: Date.now(),
        sessionId,
        channelId: channel,
        userId: user,
        threadTs: thread_ts,
        message: `Tool \`${pending.toolName}\` has been denied. Please use an alternative approach.`,
      });
      return;
    }

    // Regular conversation message — queue continue_session
    await queue.add("continue_session", {
      type: "continue_session" as const,
      timestamp: Date.now(),
      sessionId,
      channelId: channel,
      userId: user,
      threadTs: thread_ts,
      message: text,
      files,
    });

    console.log(`[Gateway] Queued continue_session for thread ${thread_ts}`);
  });

  const healthCheck = buildHealthCheck({ redis });
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
      await redis.quit();

      console.log("Shutdown complete.");
    },
    gateway, healthCheck,
    queue, worker, sessionStore,
  };
}
