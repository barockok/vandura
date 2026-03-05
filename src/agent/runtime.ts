import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, ToolPolicies } from "../config/types.js";
import { buildSystemPrompt } from "./prompt.js";

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

    // Collect guardrails from tool policies
    const guardrails: Record<string, string> = {};
    for (const [tool, policy] of Object.entries(config.toolPolicies)) {
      if (policy.guardrails) {
        guardrails[tool] = policy.guardrails;
      }
    }

    this.systemPrompt = buildSystemPrompt({
      agentName: config.agentConfig.name,
      personality: config.agentConfig.personality,
      systemPromptExtra: config.agentConfig.system_prompt_extra,
      guardrails,
    });
  }

  async chat(userMessage: string): Promise<string> {
    this.conversationHistory.push({ role: "user", content: userMessage });

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: this.systemPrompt,
      messages: this.conversationHistory,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    this.conversationHistory.push({ role: "assistant", content: text });

    return text;
  }

  getHistory(): Anthropic.MessageParam[] {
    return [...this.conversationHistory];
  }

  loadHistory(messages: Anthropic.MessageParam[]): void {
    this.conversationHistory = [...messages];
  }
}
