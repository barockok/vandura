// src/slack/onboarding-flow.ts

interface SlackClient {
  conversations: {
    open: (params: { users: string }) => Promise<{ ok: boolean; channel?: { id: string } }>;
  };
  chat: {
    postMessage: (params: { channel: string; text: string }) => Promise<unknown>;
  };
}

export class OnboardingFlow {
  constructor(private availableRoles: string[]) {}

  buildWelcomeMessage(
    _channelId: string, // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved for channel-specific welcome
  ): string {
    const roleList = this.availableRoles
      .map((r, i) => `  ${i + 1}. *${r}*`)
      .join("\n");

    return [
      `Welcome! You've joined a channel with Vandura AI agents.`,
      ``,
      `To get started, please select your role by replying with the role name or number:`,
      ``,
      roleList,
      ``,
      `Your role determines which tools and access levels are available to you.`,
    ].join("\n");
  }

  parseRoleReply(text: string): string | null {
    const normalized = text.trim().toLowerCase();

    const num = parseInt(normalized, 10);
    if (!isNaN(num) && num >= 1 && num <= this.availableRoles.length) {
      return this.availableRoles[num - 1];
    }

    if (this.availableRoles.includes(normalized)) {
      return normalized;
    }

    return null;
  }

  buildConfirmationMessage(role: string): string {
    return `You're all set! Your role is *${role}*. You're ready to use the agents in any channel where Vandura is deployed. Just @mention an agent to get started.`;
  }

  async sendDM(client: SlackClient, userId: string, text: string): Promise<void> {
    const dmResult = await client.conversations.open({ users: userId });
    if (!dmResult.ok || !dmResult.channel?.id) {
      throw new Error(`Failed to open DM with user ${userId}`);
    }
    await client.chat.postMessage({ channel: dmResult.channel.id, text });
  }
}
