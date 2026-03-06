import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, ToolPolicies } from "../config/types.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import { buildSystemPrompt } from "./prompt.js";

type ToolExecutorFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
) => Promise<ToolResult>;

export interface ChatOptions {
  tools?: ToolDefinition[];
  toolExecutor?: ToolExecutorFn;
  maxToolRounds?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: string;
    isError?: boolean;
  }>;
  usage: TokenUsage;
}

interface AgentRuntimeConfig {
  anthropicApiKey: string;
  anthropicBaseUrl?: string;
  agentConfig: AgentConfig;
  toolPolicies: ToolPolicies;
}

export class AgentRuntime {
  private client: Anthropic;
  private systemPrompt: string;
  private conversationHistory: Anthropic.MessageParam[] = [];

  constructor(config: AgentRuntimeConfig) {
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
      baseURL: config.anthropicBaseUrl,
    });

    const guardrails: Record<string, string> = {};
    for (const [tool, policy] of Object.entries(config.toolPolicies)) {
      if (tool === "_default") continue;
      const tierLabel = `[Tier ${policy.tier}] `;
      guardrails[tool] = tierLabel + (policy.guardrails ?? "");
    }

    this.systemPrompt = buildSystemPrompt({
      agentName: config.agentConfig.name,
      personality: config.agentConfig.personality,
      systemPromptExtra: config.agentConfig.system_prompt_extra,
      guardrails,
    });
  }

  async chat(userMessage: string, options?: ChatOptions): Promise<ChatResult> {
    const maxRounds = options?.maxToolRounds ?? 10;
    const toolCalls: ChatResult["toolCalls"] = [];
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    this.conversationHistory.push({ role: "user", content: userMessage });

    for (let round = 0; round <= maxRounds; round++) {
      const params: Anthropic.MessageCreateParams = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: this.systemPrompt,
        messages: this.conversationHistory,
      };

      if (options?.tools && options.tools.length > 0) {
        params.tools = options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        }));
      }

      const response = await this.client.messages.create(params);
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;

      const textParts = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);

      const toolUseBlocks = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
        const finalText = textParts.join("");
        this.conversationHistory.push({ role: "assistant", content: finalText });
        return { text: finalText, toolCalls, usage };
      }

      if (round === maxRounds) {
        throw new Error("too many tool-use rounds");
      }

      this.conversationHistory.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        let result: ToolResult;
        if (options?.toolExecutor) {
          result = await options.toolExecutor(
            block.name,
            block.input as Record<string, unknown>,
            block.id,
          );
        } else {
          result = { output: "Tool execution not configured", isError: true };
        }

        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
          output: result.output,
          isError: result.isError,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError,
        });
      }

      this.conversationHistory.push({ role: "user", content: toolResults });
    }

    throw new Error("too many tool-use rounds");
  }

  getHistory(): Anthropic.MessageParam[] {
    return [...this.conversationHistory];
  }

  loadHistory(messages: Anthropic.MessageParam[]): void {
    this.conversationHistory = [...messages];
  }
}
