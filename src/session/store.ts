import { join } from "node:path";
import type { Redis } from "ioredis";

/**
 * Pending approval state for a tool use that requires human approval.
 */
export interface PendingApproval {
  toolName: string;
  tier: 1 | 2 | 3;
  toolUseId: string;
  toolInput: Record<string, unknown>;
}

/**
 * Minimal Slack client interface needed by SessionStore.
 */
export interface SlackClient {
  postMessage(options: {
    channel: string;
    thread_ts: string;
    text: string;
    metadata?: {
      event_type: string;
      event_payload: Record<string, unknown>;
    };
  }): Promise<{ ts?: string }>;

  updateMessage(options: {
    channel: string;
    ts: string;
    text: string;
    metadata?: {
      event_type: string;
      event_payload: Record<string, unknown>;
    };
  }): Promise<void>;

  conversationsReplies(options: {
    channel: string;
    ts: string;
    limit: number;
    include_all_metadata?: boolean;
  }): Promise<{
    messages?: Array<{
      user?: string;
      ts?: string;
      text?: string;
      metadata?: {
        event_type: string;
        event_payload: Record<string, unknown>;
      };
    }>;
  }>;
}

const METADATA_EVENT_TYPE = "vandura_session";
const DEFAULT_SESSION_TTL = 7 * 24 * 3600; // 7 days in seconds

export interface SessionStoreOptions {
  redis: Redis;
  slackClient: SlackClient;
  botUserId: string;
  sessionTtl?: number;
  sessionsDir?: string;
}

/**
 * SessionStore manages session and approval state using Redis (primary)
 * with Slack thread message metadata as a backup/fallback.
 */
export class SessionStore {
  private redis: Redis;
  private slackClient: SlackClient;
  private botUserId: string;
  private sessionTtl: number;
  private sessionsDir: string;

  /** Cache: sessionId → firstMessageTs (the bot's first Slack message in the thread) */
  private firstMessageTsCache = new Map<string, string>();

  constructor(options: SessionStoreOptions) {
    this.redis = options.redis;
    this.slackClient = options.slackClient;
    this.botUserId = options.botUserId;
    this.sessionTtl = options.sessionTtl ?? DEFAULT_SESSION_TTL;
    this.sessionsDir =
      options.sessionsDir ??
      join(process.env.HOME || "/root", ".claude", "sessions");
  }

  /**
   * Create a new session: store mapping in Redis and post the first bot
   * message in the Slack thread with session metadata.
   */
  async create(
    sessionId: string,
    channelId: string,
    threadTs: string
  ): Promise<{ firstMessageTs: string }> {
    // Store thread→session mapping in Redis
    const threadKey = `thread:${channelId}:${threadTs}`;
    await this.redis.set(threadKey, sessionId, "EX", this.sessionTtl);

    // Initialize the session hash
    const sessionKey = `session:${sessionId}`;
    await this.redis.hset(sessionKey, "pendingApproval", "null");
    await this.redis.expire(sessionKey, this.sessionTtl);

    // Post the first bot message with metadata
    const result = await this.slackClient.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "On it 👀",
      metadata: {
        event_type: METADATA_EVENT_TYPE,
        event_payload: {
          sessionId,
          pendingApproval: null,
          botEngaged: true,
        },
      },
    });

    const firstMessageTs = result.ts!;
    this.firstMessageTsCache.set(sessionId, firstMessageTs);

    return { firstMessageTs };
  }

  /**
   * Resolve a thread to its session ID. Tries Redis first, then falls back
   * to reading Slack thread metadata if Redis has no data (e.g., after eviction).
   */
  async resolve(
    channelId: string,
    threadTs: string
  ): Promise<string | null> {
    // Try Redis first
    const threadKey = `thread:${channelId}:${threadTs}`;
    const sessionId = await this.redis.get(threadKey);
    if (sessionId) return sessionId;

    // Fallback: read Slack thread messages
    return this.resolveFromSlack(channelId, threadTs);
  }

  /**
   * Derive the sandbox path for a session. Pure function based on session ID
   * and the current date.
   */
  sandboxPath(sessionId: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.sessionsDir, date, sessionId);
  }

  /**
   * Store a pending approval in Redis and update the Slack message metadata.
   */
  async setPendingApproval(
    sessionId: string,
    channelId: string,
    threadTs: string,
    approval: PendingApproval
  ): Promise<void> {
    const sessionKey = `session:${sessionId}`;
    await this.redis.hset(
      sessionKey,
      "pendingApproval",
      JSON.stringify(approval)
    );

    const engaged = await this.isBotEngaged(sessionId);
    await this.updateSlackMetadata(sessionId, channelId, threadTs, {
      sessionId,
      pendingApproval: {
        toolName: approval.toolName,
        tier: approval.tier,
        toolUseId: approval.toolUseId,
      },
      botEngaged: engaged,
    });
  }

  /**
   * Get the current pending approval for a session from Redis.
   */
  async getPendingApproval(
    sessionId: string
  ): Promise<PendingApproval | null> {
    const sessionKey = `session:${sessionId}`;
    const raw = await this.redis.hget(sessionKey, "pendingApproval");
    if (!raw || raw === "null") return null;
    return JSON.parse(raw) as PendingApproval;
  }

  /**
   * Resolve (clear) a pending approval: remove from Redis and update Slack metadata.
   */
  async resolvePendingApproval(
    sessionId: string,
    channelId: string,
    threadTs: string,
    _decision: "allow" | "deny",
    _approverId: string
  ): Promise<void> {
    const sessionKey = `session:${sessionId}`;
    await this.redis.hdel(sessionKey, "pendingApproval");

    const engaged = await this.isBotEngaged(sessionId);
    await this.updateSlackMetadata(sessionId, channelId, threadTs, {
      sessionId,
      pendingApproval: null,
      botEngaged: engaged,
    });
  }

  /** Set bot engagement state for a session. Double-writes to Redis + Slack metadata. */
  async setBotEngaged(
    sessionId: string,
    channelId: string,
    threadTs: string,
    engaged: boolean,
  ): Promise<void> {
    const sessionKey = `session:${sessionId}`;
    await this.redis.hset(sessionKey, "botEngaged", engaged ? "1" : "0");

    // Read current pending approval to preserve it in metadata
    const pending = await this.getPendingApproval(sessionId);
    const pendingMeta = pending
      ? { toolName: pending.toolName, tier: pending.tier, toolUseId: pending.toolUseId }
      : null;

    await this.updateSlackMetadata(sessionId, channelId, threadTs, {
      sessionId,
      pendingApproval: pendingMeta,
      botEngaged: engaged,
    });
  }

  /** Check if bot is engaged for a session. Defaults to true if not set. */
  async isBotEngaged(sessionId: string): Promise<boolean> {
    const sessionKey = `session:${sessionId}`;
    const val = await this.redis.hget(sessionKey, "botEngaged");
    return val !== "0";
  }

  // ---- Private helpers ----

  /**
   * Fallback: resolve session ID from Slack thread metadata, then rehydrate Redis.
   */
  private async resolveFromSlack(
    channelId: string,
    threadTs: string
  ): Promise<string | null> {
    const result = await this.slackClient.conversationsReplies({
      channel: channelId,
      ts: threadTs,
      limit: 10,
      include_all_metadata: true,
    });

    const messages = result.messages ?? [];
    const botMessage = messages.find(
      (m) =>
        m.user === this.botUserId &&
        m.metadata?.event_type === METADATA_EVENT_TYPE
    );

    if (!botMessage?.metadata) return null;

    const payload = botMessage.metadata.event_payload;
    const sessionId = payload.sessionId as string;
    if (!sessionId) return null;

    // Rehydrate Redis
    const threadKey = `thread:${channelId}:${threadTs}`;
    await this.redis.set(threadKey, sessionId, "EX", this.sessionTtl);

    // Rehydrate session hash
    const sessionKey = `session:${sessionId}`;
    const pendingApproval = payload.pendingApproval as Record<
      string,
      unknown
    > | null;
    if (pendingApproval) {
      // Note: toolInput is NOT stored in Slack metadata (16KB limit),
      // so rehydrated approval will have an empty toolInput.
      await this.redis.hset(
        sessionKey,
        "pendingApproval",
        JSON.stringify({
          toolName: pendingApproval.toolName,
          tier: pendingApproval.tier,
          toolUseId: pendingApproval.toolUseId,
          toolInput: {},
        })
      );
    } else {
      await this.redis.hset(sessionKey, "pendingApproval", "null");
    }

    // Rehydrate bot engagement state
    const botEngaged = payload.botEngaged;
    if (botEngaged === false) {
      await this.redis.hset(sessionKey, "botEngaged", "0");
    }

    await this.redis.expire(sessionKey, this.sessionTtl);

    // Cache the first message ts
    if (botMessage.ts) {
      this.firstMessageTsCache.set(sessionId, botMessage.ts);
    }

    return sessionId;
  }

  /**
   * Update the first bot message's metadata in the Slack thread.
   * Uses an internal cache to track which message to update.
   */
  private async updateSlackMetadata(
    sessionId: string,
    channelId: string,
    threadTs: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    let messageTs = this.firstMessageTsCache.get(sessionId);

    if (!messageTs) {
      // Look up the first bot message in the thread
      const result = await this.slackClient.conversationsReplies({
        channel: channelId,
        ts: threadTs,
        limit: 10,
      });

      const messages = result.messages ?? [];
      const botMessage = messages.find(
        (m) =>
          m.user === this.botUserId &&
          m.metadata?.event_type === METADATA_EVENT_TYPE
      );

      if (!botMessage?.ts) return;
      messageTs = botMessage.ts;
      this.firstMessageTsCache.set(sessionId, messageTs);
    }

    await this.slackClient.updateMessage({
      channel: channelId,
      ts: messageTs,
      text: "On it 👀",
      metadata: {
        event_type: METADATA_EVENT_TYPE,
        event_payload: payload,
      },
    });
  }
}
