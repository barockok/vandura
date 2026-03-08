import { Worker, Job } from "bullmq";
import { getRedisOptions, QUEUE_NAME } from "./index.js";
import type { JobData, JobResult, StartSessionJobData, ContinueSessionJobData, ApproveToolJobData, Session } from "./types.js";
import { createSession, getSession, updateSessionStatus } from "../agent/session.js";
import { loadMcpConfig } from "../agent/mcp-loader.js";
import { resolvePendingApproval, getPendingApproval, loadToolPolicies } from "../agent/permissions.js";
import { runSession, resumeSession, continueSession, type AgentMessage, type ApprovalCallback } from "../agent/sdk-runtime.js";

// Slack client placeholder - will be injected
let slackClient: {
  postMessage: (channelId: string, message: string, threadTs?: string) => Promise<void>;
  postApprovalRequest: (channelId: string, toolName: string, toolInput: Record<string, unknown>, tier: number, threadTs?: string) => Promise<void>;
} | null = null;

/**
 * Set the Slack client for sending messages
 */
export function setSlackClient(client: typeof slackClient): void {
  slackClient = client;
}

// MCP config cache
let mcpConfig: Awaited<ReturnType<typeof loadMcpConfig>> | null = null;

/**
 * Get or load MCP config
 */
async function getMcpConfig() {
  if (!mcpConfig) {
    mcpConfig = await loadMcpConfig("config/mcp-servers.yml");
  }
  return mcpConfig;
}

/**
 * Send message to Slack
 */
async function sendToSlack(session: Session, message: AgentMessage): Promise<void> {
  if (!slackClient) {
    console.warn(`[Worker] Slack client not set, cannot send message`);
    return;
  }

  switch (message.type) {
    case "text":
      await slackClient.postMessage(session.channelId, message.content || "", session.threadTs || undefined);
      break;

    case "error":
      await slackClient.postMessage(
        session.channelId,
        `❌ Error: ${message.content}`,
        session.threadTs || undefined
      );
      break;

    case "complete":
      // Session completed - could send a completion message
      break;

    default:
      // Tool use/result messages can be logged or sent as ephemeral
      console.log(`[Worker] Tool message: ${message.type} - ${message.toolName}`);
  }
}

/**
 * Request approval via Slack
 */
const requestApproval: ApprovalCallback = async (approval, session) => {
  if (!slackClient) {
    console.warn(`[Worker] Slack client not set, cannot request approval`);
    return;
  }

  await slackClient.postApprovalRequest(
    session.channelId,
    approval.toolName,
    approval.toolInput,
    approval.tier,
    session.threadTs || undefined
  );

  await updateSessionStatus(session.id, "awaiting_approval");
};

/**
 * Process a start_session job
 */
async function processStartSession(job: Job<StartSessionJobData>): Promise<JobResult> {
  const { channelId, userId, message, threadTs } = job.data;

  console.log(`[Worker] Starting session for channel ${channelId}, user ${userId}`);

  // Load tool policies if not loaded
  await loadToolPolicies("config/tool-policies.yml");

  // Create session with sandbox directory
  const session = await createSession({
    channelId,
    userId,
    threadTs,
  });

  console.log(`[Worker] Created session ${session.id} at ${session.sandboxPath}`);

  // Get MCP config
  const mcpConfig = await getMcpConfig();

  // Run the agent session
  const result = await runSession(
    session,
    message,
    mcpConfig,
    (msg) => sendToSlack(session, msg),
    requestApproval
  );

  return {
    success: result.status !== "error",
    sessionId: session.id,
    message: result.status === "awaiting_approval"
      ? `Session ${session.id} awaiting approval`
      : `Session ${session.id} ${result.status}`,
    error: result.error,
  };
}

/**
 * Process a continue_session job
 */
async function processContinueSession(job: Job<ContinueSessionJobData>): Promise<JobResult> {
  const { sessionId, message } = job.data;

  console.log(`[Worker] Continuing session ${sessionId}`);

  // Get existing session
  const session = await getSession(sessionId);
  if (!session) {
    return {
      success: false,
      error: `Session ${sessionId} not found`,
    };
  }

  // Update status
  await updateSessionStatus(sessionId, "active");

  // Get MCP config
  const mcpConfig = await getMcpConfig();

  // Continue the session
  const result = await continueSession(
    session,
    message,
    mcpConfig,
    (msg) => sendToSlack(session, msg),
    requestApproval
  );

  return {
    success: result.status !== "error",
    sessionId: session.id,
    message: `Session ${session.id} ${result.status}`,
    error: result.error,
  };
}

/**
 * Process an approve_tool job
 */
async function processApproveTool(job: Job<ApproveToolJobData>): Promise<JobResult> {
  const { sessionId, toolUseId, decision, approverId } = job.data;

  console.log(`[Worker] Processing approval for session ${sessionId}, tool ${toolUseId}: ${decision}`);

  // Get existing session
  const session = await getSession(sessionId);
  if (!session) {
    return {
      success: false,
      error: `Session ${sessionId} not found`,
    };
  }

  // Get pending approval
  const approval = await getPendingApproval(sessionId);
  if (!approval) {
    return {
      success: false,
      error: `No pending approval for session ${sessionId}`,
    };
  }

  // Resolve the approval
  await resolvePendingApproval(sessionId, decision, approverId);

  if (decision === "deny") {
    // Update session status and notify
    await updateSessionStatus(sessionId, "active");

    if (slackClient) {
      await slackClient.postMessage(
        session.channelId,
        `Tool "${approval.toolName}" was denied. The agent will try an alternative approach.`,
        session.threadTs || undefined
      );
    }

    return {
      success: true,
      sessionId,
      message: `Tool ${approval.toolName} denied`,
    };
  }

  // Update session status
  await updateSessionStatus(sessionId, "active");

  // Get MCP config
  const mcpConfig = await getMcpConfig();

  // Resume session with approved tool
  const result = await resumeSession(
    session,
    mcpConfig,
    (msg) => sendToSlack(session, msg),
    requestApproval,
    approval.toolName
  );

  return {
    success: result.status !== "error",
    sessionId,
    message: `Session resumed, tool ${approval.toolName} approved`,
    error: result.error,
  };
}

/**
 * Main job processor - routes to appropriate handler
 */
async function processJob(job: Job<JobData>): Promise<JobResult> {
  console.log(`[Worker] Processing job ${job.id}: ${job.name}`);

  try {
    switch (job.name) {
      case "start_session":
        return await processStartSession(job as Job<StartSessionJobData>);

      case "continue_session":
        return await processContinueSession(job as Job<ContinueSessionJobData>);

      case "approve_tool":
        return await processApproveTool(job as Job<ApproveToolJobData>);

      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  } catch (error) {
    console.error(`[Worker] Error processing job ${job.id}:`, error);
    throw error;
  }
}

/**
 * Create and start the worker
 */
export function createWorker(): Worker<JobData, JobResult, string> {
  const worker = new Worker<JobData, JobResult>(
    QUEUE_NAME,
    processJob,
    {
      connection: getRedisOptions(),
      concurrency: 5, // Process up to 5 jobs concurrently
      limiter: {
        max: 10, // Max 10 jobs per duration
        duration: 1000, // Per second
      },
    }
  );

  worker.on("completed", (job: Job<JobData>, result: JobResult) => {
    console.log(`[Worker] Job ${job.id} completed:`, result.message);
  });

  worker.on("failed", (job: Job<JobData> | undefined, error: Error) => {
    console.error(`[Worker] Job ${job?.id} failed:`, error.message);
  });

  worker.on("error", (error: Error) => {
    console.error(`[Worker] Worker error:`, error);
  });

  console.log(`[Worker] Started worker for queue: ${QUEUE_NAME}`);

  return worker;
}

/**
 * Close worker gracefully
 */
export async function closeWorker(worker: Worker): Promise<void> {
  console.log(`[Worker] Closing worker...`);
  await worker.close();
  console.log(`[Worker] Worker closed`);
}