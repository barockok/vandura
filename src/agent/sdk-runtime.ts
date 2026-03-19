import { query, type Options, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Sanitize internal error messages so they don't leak implementation details
 * (e.g. "Claude Code process terminated by signal SIGKILL") to end users.
 */
function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Log the real error for debugging
  console.error(`[Runtime] Raw error: ${raw}`);
  // Return a generic message — never expose internals to Slack
  return "Something went wrong while processing your request. Please try again.";
}
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { env } from "../config/env.js";
import type { AgentConfig } from "../config/types.js";
import type { Session } from "../queue/types.js";
import type { LoadedMcpConfig } from "./mcp-loader.js";
import { getAllGuardrails } from "./permissions.js";
import { buildSystemPrompt } from "./prompt.js";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
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
  isResuming: boolean = false,
  sdkMcpServers?: Record<string, McpSdkServerConfigWithInstance>,
  hookFns?: { preToolUse?: HookCallback; postToolUse?: HookCallback },
): Options {
  // Build system prompt with guardrails
  let systemPrompt: string | undefined;
  if (agentConfig) {
    // Build guardrails from tool-policies.yml (single source of truth)
    const guardrails = getAllGuardrails();

    systemPrompt = buildSystemPrompt({
      agentName: agentConfig.name,
      personality: agentConfig.personality,
      systemPromptExtra: agentConfig.system_prompt_extra,
      guardrails,
      memoryDir: env.VANDURA_MEMORY_DIR,
      exportSummaryMaxSize: env.EXPORT_SUMMARY_MAX_SIZE,
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

  // Merge external MCP servers (stdio) with in-process SDK MCP servers
  const allMcpServers: Record<string, any> = {
    ...mcpConfig.servers,
    ...sdkMcpServers,
  };

  const queryOptions: Options = {
    cwd: session.sandboxPath,
    // Pass all MCP servers via the mcpServers option (both stdio and SDK)
    ...(Object.keys(allMcpServers).length > 0 ? { mcpServers: allMcpServers } : {}),
    persistSession: true, // Always persist — transcripts must be available across nodes
    model: env.ANTHROPIC_MODEL,
    pathToClaudeCodeExecutable: env.CLAUDE_CODE_PATH,
    systemPrompt,
    // Debug logging — enable with CLAUDE_DEBUG=true
    ...(env.CLAUDE_DEBUG ? {
      debug: true,
      stderr: (data: string) => {
        process.stderr.write(`[Claude:${session.id.substring(0, 8)}] ${data}`);
      },
    } : {}),
    hooks: {
      PreToolUse: [{ hooks: [hookFns?.preToolUse ?? preToolUseHook] }],
      PostToolUse: [{ hooks: [hookFns?.postToolUse ?? postToolUseHook] }],
    },
    // Allow all tools at SDK level — our PreToolUse hook handles maker-checker
    canUseTool: async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      return { behavior: "allow", updatedInput: input };
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
  agentConfig?: AgentConfig,
  sdkMcpServers?: Record<string, McpSdkServerConfigWithInstance>,
  hookFns?: { preToolUse?: HookCallback; postToolUse?: HookCallback },
): Promise<SessionResult> {
  const options = createQueryOptions(session, mcpConfig, agentConfig, false, sdkMcpServers, hookFns);

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
    const userMessage = sanitizeErrorMessage(error);
    await onMessage({
      type: "error",
      content: userMessage,
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
  agentConfig?: AgentConfig,
  sdkMcpServers?: Record<string, McpSdkServerConfigWithInstance>,
  hookFns?: { preToolUse?: HookCallback; postToolUse?: HookCallback },
): Promise<SessionResult> {
  const options = createQueryOptions(session, mcpConfig, agentConfig, true, sdkMcpServers, hookFns);

  // Try to resume existing session; if the session is stale (e.g. after
  // container restart), fall back to starting a fresh session.
  for (const attempt of ["resume", "fresh"] as const) {
    try {
      const queryOptions = attempt === "resume"
        ? { ...options, resume: session.id }
        : { ...options, sessionId: session.id };

      const queryResult = query({
        prompt: userMessage,
        options: queryOptions,
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
      if (attempt === "resume") {
        console.warn(`[Runtime] Resume failed for session ${session.id}, retrying as fresh session:`, error instanceof Error ? error.message : error);
        continue;
      }

      console.error(`[Runtime] Error continuing session ${session.id}:`, error);
      const userMsg = sanitizeErrorMessage(error);
      await onMessage({
        type: "error",
        content: userMsg,
        sessionId: session.id,
      });
      return {
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // Unreachable, but TypeScript needs it
  return { status: "error", error: "Unexpected state" };
}
