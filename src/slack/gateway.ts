import type { App } from "@slack/bolt";

type SayFn = (message: string | Record<string, unknown>) => Promise<unknown>;

export interface MentionPayload {
  user: string;
  text: string;
  channel: string;
  ts: string;
  say: SayFn;
}

export interface ThreadMessagePayload {
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts: string;
  say: SayFn;
}

export interface MemberJoinedPayload {
  user: string;
  channel: string;
}

export class SlackGateway {
  constructor(private app: App) {}

  onMention(handler: (payload: MentionPayload) => void | Promise<void>): void {
    this.app.event("app_mention", async ({ event, say }) => {
      await handler({
        user: event.user,
        text: event.text,
        channel: event.channel,
        ts: event.ts,
        say,
      });
    });
  }

  onThreadMessage(handler: (payload: ThreadMessagePayload) => void | Promise<void>): void {
    this.app.event("message", async ({ event, say }) => {
      const msg = event as Record<string, unknown>;

      // Only handle thread replies (must have thread_ts)
      if (!msg.thread_ts) return;

      // Ignore bot messages
      if (msg.bot_id) return;

      await handler({
        user: msg.user as string,
        text: msg.text as string,
        channel: msg.channel as string,
        ts: msg.ts as string,
        thread_ts: msg.thread_ts as string,
        say,
      });
    });
  }

  onMemberJoined(handler: (payload: MemberJoinedPayload) => void | Promise<void>): void {
    this.app.event("member_joined_channel", async ({ event }) => {
      await handler({
        user: event.user,
        channel: event.channel,
      });
    });
  }

  async start(): Promise<void> {
    await this.app.start();
  }
}
