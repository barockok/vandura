import { query, type Options, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { env } from "../config/env.js";
import type { AgentConfig } from "../config/types.js";
import type { Session } from "../queue/types.js";
import type { LoadedMcpConfig } from "./mcp-loader.js";
import { buildSystemPrompt } from "./prompt.js";
import { preToolUseHook } from "../hooks/pre-tool-use.js";
import { postToolUseHook } from "../hooks/post-tool-use.js";

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
 * Result of running an agent session
 */
export interface SessionResult {
  status: "completed" | "error";
  error?: string;
}

/**
 * Create SDK query options for a session
 */
export function createQueryOptions(
  session: Session,
  mcpConfig: LoadedMcpConfig,
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

  // Build environment for Claude Code - exclude Claude Code internal variables
  // to prevent "nested session" detection
  const claudeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Skip Claude Code internal variables that cause nested session detection
    if (!key.startsWith('CLAUDECODE') && value !== undefined) {
      claudeEnv[key] = value;
    }
  }

  const queryOptions: Options = {
    cwd: session.sandboxPath,
    mcpServers: mcpConfig.servers,
    persistSession: !isResuming, // Don't persist when resuming - we're continuing existing session
    model: env.ANTHROPIC_MODEL,
    pathToClaudeCodeExecutable: env.CLAUDE_CODE_PATH,
    systemPrompt,
    permissionMode: "acceptEdits",
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook] }],
      PostToolUse: [{ hooks: [postToolUseHook] }],
    },
    // sessionId cannot be used with resume - SDK manages session ID for resumed sessions
    ...(isResuming ? {} : { sessionId: session.id }),
    env: {
      // Include full environment so Claude Code can find commands like npx
      ...claudeEnv,
      // Override with specific SDK settings
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "vandura/1.0.0",
    },
  };

  return queryOptions;
}

/**
 * Run an agent session using SDK query()
 */
export async function runSession(
  session: Session,
  userMessage: string,
  mcpConfig: LoadedMcpConfig,
  onMessage: MessageCallback,
  agentConfig?: AgentConfig
): Promise<SessionResult> {
  const options = createQueryOptions(session, mcpConfig, agentConfig);

  try {
    const queryResult = query({
      prompt: userMessage,
      options,
    });

    for await (const msg of queryResult) {
      const agentMessage = processSdkMessage(msg, session.id);
      if (agentMessage) {
        await onMessage(agentMessage);
      }
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

    case "tool_use_summary": {
      // Tool execution results - send to Slack
      return {
        type: "text",
        content: msg.summary,
        sessionId,
      };
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
  agentConfig?: AgentConfig
): Promise<SessionResult> {
  const options = createQueryOptions(session, mcpConfig, agentConfig, true);

  try {
    const queryResult = query({
      prompt: userMessage,
      options: {
        ...options,
        resume: session.id,
      },
    });

    for await (const msg of queryResult) {
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
