interface PromptParams {
  agentName: string;
  personality?: string;
  systemPromptExtra?: string;
  guardrails?: Record<string, string>;
}

export function buildSystemPrompt(params: PromptParams): string {
  const sections: string[] = [];

  // 1. Agent identity
  sections.push(
    `You are ${params.agentName}, an AI agent in the Vandura system.`
  );

  // 2. Context
  sections.push(
    "You operate in Slack channels. All actions are visible to the team."
  );

  // 3. Personality
  if (params.personality) {
    sections.push(`## Personality\n${params.personality}`);
  }

  // 4. System prompt extra
  if (params.systemPromptExtra) {
    sections.push(params.systemPromptExtra);
  }

  // 5. Tool-specific guardrails
  if (params.guardrails && Object.keys(params.guardrails).length > 0) {
    const guardrailLines = Object.entries(params.guardrails)
      .map(([tool, rule]) => `- **${tool}**: ${rule}`)
      .join("\n");
    sections.push(`## Guardrails\n${guardrailLines}`);
  }

  // 6. Approval rules
  sections.push(
    [
      "## Approval Rules",
      "- Tier 1: Auto-approved. Execute immediately without asking.",
      "- Tier 2: Requires human approval before execution. Ask and wait.",
      "- Tier 3: Restricted. Do not attempt to execute. Inform the user that approval from an authorized person is required.",
    ].join("\n")
  );

  return sections.join("\n\n");
}
