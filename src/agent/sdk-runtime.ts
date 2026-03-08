import { query, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { env } from "../config/env.js";
import type { PendingApproval, Session } from "../queue/types.js";
import type { LoadedMcpConfig } from "./mcp-loader.js";
import { getToolTier, getToolInfo } from "./permissions.js";
import { updateServerSessionId } from "./session.js";
import { buildSystemPrompt } from "./prompt.js";
import type { AgentConfig } from "../config/types.js";

/**
 * Message types for streaming to Slack
 */
export interface AgentMessage {
  type: "text" | "tool_use" | "tool_result" | "error" | "complete";
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  sessionId?: string;
}

/**
 * Callback for sending messages to Slack
 */
export type MessageCallback = (message: AgentMessage) => Promise<void>;

/**
 * Callback for requesting approval via Slack
 */
export type ApprovalCallback = (approval: PendingApproval, session: Session) => Promise<void>;

/**
 * Result of running an agent session
 */
export interface SessionResult {
  status: "completed" | "awaiting_approval" | "error";
  error?: string;
  approval?: PendingApproval;
}

/**
 * Error thrown when session is interrupted for approval
 */
export class ApprovalRequiredError extends Error {
  constructor(public approval: PendingApproval) {
    super(`Approval required for tool: ${approval.toolName}`);
    this.name = "ApprovalRequiredError";
  }
}

/**
 * Create SDK query options for a session
 */
export function createQueryOptions(
  session: Session,
  mcpConfig: LoadedMcpConfig,
  onApprovalNeeded: ApprovalCallback,
  agentConfig?: AgentConfig,
  isResuming: boolean = false
): Options {
  // Build system prompt with guardrails
  let systemPrompt: string | undefined;
  if (agentConfig) {
    // Build guardrails from MCP config tool tiers
    const guardrails: Record<string, string> = {};
    for (const [toolName, info] of mcpConfig.toolTiers.entries()) {
      if (info.guardrails) {
        guardrails[toolName] = info.guardrails;
      }
    }

    systemPrompt = buildSystemPrompt({
      agentName: agentConfig.name,
      personality: agentConfig.personality,
      systemPromptExtra: agentConfig.system_prompt_extra,
      guardrails,
    });
  }

  // Create permission callback wrapper
  const permissionHandler = async (
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; signal: AbortSignal }
  ): Promise<PermissionResult> => {
    const tier = getToolTier(toolName);

    // Tier 1: Auto-approve
    if (tier === 1) {
      console.log(`[Runtime] Auto-approving tier 1 tool: ${toolName}`);
      return { behavior: "allow" };
    }

    // Tier 2/3: Request approval
    console.log(`[Runtime] Requesting approval for tier ${tier} tool: ${toolName}`);

    const { storePendingApproval } = await import("./permissions.js");
    const approval = await storePendingApproval({
      sessionId: session.id,
      toolName,
      toolInput: input,
      toolUseId: opts.toolUseID,
      tier,
    });

    await onApprovalNeeded(approval, session);

    // Return deny with interrupt to pause session until approval
    return {
      behavior: "deny",
      message: `Approval required for ${toolName} (tier ${tier}).`,
      interrupt: true,
    };
  };

  return {
    cwd: session.sandboxPath,
    mcpServers: mcpConfig.servers,
    canUseTool: permissionHandler,
    persistSession: !isResuming, // Don't persist when resuming - we're continuing existing session
    model: env.ANTHROPIC_MODEL,
    pathToClaudeCodeExecutable: env.CLAUDE_CODE_PATH,
    systemPrompt,
    env: {
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "vandura/1.0.0",
    },
  };
}

/**
 * Run an agent session using SDK query()
 */
export async function runSession(
  session: Session,
  userMessage: string,
  mcpConfig: LoadedMcpConfig,
  onMessage: MessageCallback,
  onApprovalNeeded: ApprovalCallback,
  agentConfig?: AgentConfig
): Promise<SessionResult> {
  console.log(`[Runtime] Starting session ${session.id}`);

  const options = createQueryOptions(session, mcpConfig, onApprovalNeeded, agentConfig);

  try {
    const queryResult = query({
      prompt: userMessage,
      options,
    });

    let capturedServerSessionId: string | null = null;

    // Process message stream
    for await (const msg of queryResult) {
      // Capture server session ID from result message IMMEDIATELY
      if (msg.type === "result" && (msg as any).session_id) {
        const serverSessionId = (msg as any).session_id;
        capturedServerSessionId = serverSessionId;
        console.log(`[Runtime] Captured server session ID: ${serverSessionId}`);
        // Persist immediately so continue_session can use it
        await updateServerSessionId(session.id, serverSessionId);
      }

      const agentMessage = processSdkMessage(msg, session.id);

      if (agentMessage) {
        await onMessage(agentMessage);
      }
    }

    // Ensure server session ID is persisted before session completes
    if (capturedServerSessionId && !session.serverSessionId) {
      console.log(`[Runtime] Ensuring server session ID is persisted: ${capturedServerSessionId}`);
      // Already persisted above, but session object in memory still has old value
      // The DB has the correct value, so continue_session will pick it up
    }

    await onMessage({ type: "complete", sessionId: session.id });

    return { status: "completed" };
  } catch (error) {
    console.error(`[Runtime] Error in session ${session.id}:`, error);

    await onMessage({
      type: "error",
      content: error instanceof Error ? error.message : "Unknown error",
      sessionId: session.id,
    });

    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Resume a session after approval
 */
export async function resumeSession(
  session: Session,
  mcpConfig: LoadedMcpConfig,
  onMessage: MessageCallback,
  onApprovalNeeded: ApprovalCallback,
  allowedTool?: string,
  agentConfig?: AgentConfig
): Promise<SessionResult> {
  console.log(`[Runtime] Resuming session ${session.id}`);
  console.log(`[Runtime] Server session ID: ${session.serverSessionId || "not stored"}`);

  const options = createQueryOptions(session, mcpConfig, onApprovalNeeded, agentConfig, true);

  // If we have an allowed tool, add it to allowedTools
  if (allowedTool) {
    options.allowedTools = [allowedTool];
  }

  try {
    const queryResult = query({
      prompt: "", // Empty prompt for resume
      options: {
        ...options,
        // Use stored server session ID if available
        ...(session.serverSessionId ? { resume: session.serverSessionId } : {}),
      },
    });

    // Process message stream
    for await (const msg of queryResult) {
      // Capture server session ID from result message
      if (msg.type === "result" && (msg as any).session_id) {
        const serverSessionId = (msg as any).session_id;
        console.log(`[Runtime] Updated server session ID: ${serverSessionId}`);
        await updateServerSessionId(session.id, serverSessionId);
      }

      const agentMessage = processSdkMessage(msg, session.id);

      if (agentMessage) {
        await onMessage(agentMessage);
      }
    }

    await onMessage({ type: "complete", sessionId: session.id });

    return { status: "completed" };
  } catch (error) {
    console.error(`[Runtime] Error resuming session ${session.id}:`, error);

    await onMessage({
      type: "error",
      content: error instanceof Error ? error.message : "Unknown error",
      sessionId: session.id,
    });

    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Process an SDK message into our AgentMessage format
 */
function processSdkMessage(msg: SDKMessage, sessionId: string): AgentMessage | null {
  switch (msg.type) {
    case "assistant": {
      // Extract text from assistant message
      const textBlocks = msg.message.content.filter(
        (block): block is BetaTextBlock => block.type === "text"
      );
      const textContent = textBlocks.map((block) => block.text).join("\n");

      if (textContent) {
        return {
          type: "text",
          content: textContent,
          sessionId,
        };
      }
      return null;
    }

    case "result":
      return {
        type: "complete",
        sessionId,
      };

    case "stream_event":
      // Partial streaming - we can ignore for now
      return null;

    default:
      return null;
  }
}

/**
 * Continue a session with user input
 */
export async function continueSession(
  session: Session,
  userMessage: string,
  mcpConfig: LoadedMcpConfig,
  onMessage: MessageCallback,
  onApprovalNeeded: ApprovalCallback,
  agentConfig?: AgentConfig
): Promise<SessionResult> {
  console.log(`[Runtime] Continuing session ${session.id}`);
  console.log(`[Runtime] Server session ID: ${session.serverSessionId || "not stored"}`);

  const options = createQueryOptions(session, mcpConfig, onApprovalNeeded, agentConfig, true);

  try {
    const queryOptions: any = {
      prompt: userMessage,
      options: {
        ...options,
        // Use stored server session ID if available
        ...(session.serverSessionId ? { resume: session.serverSessionId } : {}),
      },
    };

    // If no server session ID, log a warning - context will be lost
    if (!session.serverSessionId) {
      console.warn(`[Runtime] No server session ID for session ${session.id} - starting fresh context`);
    }

    const queryResult = query(queryOptions);

    // Process message stream
    for await (const msg of queryResult) {
      // Capture server session ID from result message
      if (msg.type === "result" && (msg as any).session_id) {
        const serverSessionId = (msg as any).session_id;
        console.log(`[Runtime] Updated server session ID: ${serverSessionId}`);
        await updateServerSessionId(session.id, serverSessionId);
      }

      const agentMessage = processSdkMessage(msg, session.id);

      if (agentMessage) {
        await onMessage(agentMessage);
      }
    }

    await onMessage({ type: "complete", sessionId: session.id });

    return { status: "completed" };
  } catch (error) {
    console.error(`[Runtime] Error continuing session ${session.id}:`, error);

    await onMessage({
      type: "error",
      content: error instanceof Error ? error.message : "Unknown error",
      sessionId: session.id,
    });

    return {
      status: "error",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}