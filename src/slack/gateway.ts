import type { App } from "@slack/bolt";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (message: any) => Promise<unknown>;

export interface MentionPayload {
  user: string;
  text: string;
  channel: string;
  ts: string;
  say: SayFn;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private_download: string;
    size: number;
  }>;
}

export interface ThreadMessagePayload {
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts: string;
  say: SayFn;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private_download: string;
    size: number;
  }>;
}

export interface MemberJoinedPayload {
  user: string;
  channel: string;
}

export class SlackGateway {
  private botUserId: string | null = null;
  private processedMentions = new Set<string>();
  private threadHandler: ((payload: ThreadMessagePayload) => void | Promise<void>) | null = null;

  constructor(private app: App) {}

  setBotUserId(botUserId: string): void {
    this.botUserId = botUserId;
  }

  onMention(handler: (payload: MentionPayload) => void | Promise<void>): void {
    const dedupedHandler = async (payload: MentionPayload) => {
      // Deduplicate: Slack fires both app_mention and message events for @mentions
      if (this.processedMentions.has(payload.ts)) return;
      this.processedMentions.add(payload.ts);

      // Prevent unbounded growth — prune old entries after 1000
      if (this.processedMentions.size > 1000) {
        const entries = [...this.processedMentions];
        for (let i = 0; i < 500; i++) this.processedMentions.delete(entries[i]);
      }

      await handler(payload);
    };

    // Listen for app_mention events (from real user messages)
    this.app.event("app_mention", async ({ event, say }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = event as any;

      // If this mention is inside a thread, route to threadHandler instead
      // (re-engaging the bot in an existing thread should continue, not start new)
      if (e.thread_ts && this.threadHandler) {
        await this.threadHandler({
          user: e.user ?? "",
          text: e.text ?? "",
          channel: e.channel,
          ts: e.ts,
          thread_ts: e.thread_ts,
          say: say as SayFn,
          files: (e.files as any[])?.map((f: any) => ({
            id: f.id, name: f.name, mimetype: f.mimetype,
            url_private_download: f.url_private_download, size: f.size,
          })),
        });
        return;
      }

      await dedupedHandler({
        user: e.user ?? "",
        text: e.text ?? "",
        channel: e.channel,
        ts: e.ts,
        say: say as SayFn,
        files: (e.files as any[])?.map((f: any) => ({
          id: f.id, name: f.name, mimetype: f.mimetype,
          url_private_download: f.url_private_download, size: f.size,
        })),
      });
    });

    // Also listen for message events that mention the bot
    // (Slack doesn't fire app_mention for bot-authored messages)
    this.app.event("message", async ({ event, say }) => {
      const msg = event as unknown as Record<string, unknown>;

      // Only handle top-level messages (not thread replies)
      if (msg.thread_ts) return;

      // Only handle messages that mention the bot via text
      if (!this.botUserId) return;
      const text = (msg.text as string) ?? "";
      if (!text.includes(`<@${this.botUserId}>`)) return;

      // Skip if this is from our own bot (avoid self-loop)
      if (msg.user === this.botUserId) return;

      await dedupedHandler({
        user: (msg.user as string) ?? "",
        text,
        channel: msg.channel as string,
        ts: msg.ts as string,
        say: say as SayFn,
        files: (msg.files as any[])?.map((f: any) => ({
          id: f.id, name: f.name, mimetype: f.mimetype,
          url_private_download: f.url_private_download, size: f.size,
        })),
      });
    });
  }

  onThreadMessage(handler: (payload: ThreadMessagePayload) => void | Promise<void>): void {
    this.threadHandler = handler;
    this.app.event("message", async ({ event, say }) => {
      const msg = event as unknown as Record<string, unknown>;

      // Only handle thread replies (must have thread_ts)
      if (!msg.thread_ts) return;

      // Ignore messages from our own bot (avoid self-loop)
      if (this.botUserId && msg.user === this.botUserId) return;

      await handler({
        user: msg.user as string,
        text: msg.text as string,
        channel: msg.channel as string,
        ts: msg.ts as string,
        thread_ts: msg.thread_ts as string,
        say: say as SayFn,
        files: (msg.files as any[])?.map((f: any) => ({
          id: f.id, name: f.name, mimetype: f.mimetype,
          url_private_download: f.url_private_download, size: f.size,
        })),
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
