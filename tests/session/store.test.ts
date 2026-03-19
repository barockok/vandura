import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionStore } from "../../src/session/store.js";
import type { SlackClient, PendingApproval } from "../../src/session/store.js";

// ---- Mock Redis ----
function createMockRedis() {
  const store = new Map<string, string>();
  const hashStore = new Map<string, Map<string, string>>();

  return {
    store,
    hashStore,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ex?: string, _ttl?: number) => {
      store.set(key, value);
      return "OK";
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (!hashStore.has(key)) hashStore.set(key, new Map());
      hashStore.get(key)!.set(field, value);
      return 1;
    }),
    hget: vi.fn(async (key: string, field: string) => {
      return hashStore.get(key)?.get(field) ?? null;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      hashStore.get(key)?.delete(field);
      return 1;
    }),
    expire: vi.fn(async () => 1),
  };
}

// ---- Mock Slack client ----
function createMockSlackClient(): SlackClient & {
  postMessage: ReturnType<typeof vi.fn>;
  updateMessage: ReturnType<typeof vi.fn>;
  conversationsReplies: ReturnType<typeof vi.fn>;
} {
  return {
    postMessage: vi.fn(async () => ({ ts: "1234567890.000001" })),
    updateMessage: vi.fn(async () => undefined),
    conversationsReplies: vi.fn(async () => ({ messages: [] })),
  };
}

const BOT_USER_ID = "U_BOT_123";
const CHANNEL_ID = "C_CHANNEL_1";
const THREAD_TS = "1700000000.000000";
const SESSION_ID = "sess_abc123";

function createStore(
  redis: ReturnType<typeof createMockRedis>,
  slack: ReturnType<typeof createMockSlackClient>,
  overrides: Partial<{ sessionTtl: number; sessionsDir: string }> = {}
) {
  return new SessionStore({
    redis: redis as any,
    slackClient: slack,
    botUserId: BOT_USER_ID,
    ...overrides,
  });
}

describe("SessionStore", () => {
  let redis: ReturnType<typeof createMockRedis>;
  let slack: ReturnType<typeof createMockSlackClient>;
  let store: SessionStore;

  beforeEach(() => {
    redis = createMockRedis();
    slack = createMockSlackClient();
    store = createStore(redis, slack);
  });

  describe("create", () => {
    it("stores thread→session mapping in Redis", async () => {
      await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      expect(redis.set).toHaveBeenCalledWith(
        `thread:${CHANNEL_ID}:${THREAD_TS}`,
        SESSION_ID,
        "EX",
        7 * 24 * 3600
      );
    });

    it("initializes session hash in Redis", async () => {
      await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      expect(redis.hset).toHaveBeenCalledWith(
        `session:${SESSION_ID}`,
        "pendingApproval",
        "null"
      );
      expect(redis.expire).toHaveBeenCalledWith(
        `session:${SESSION_ID}`,
        7 * 24 * 3600
      );
    });

    it("posts first Slack message with metadata", async () => {
      await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      expect(slack.postMessage).toHaveBeenCalledWith({
        channel: CHANNEL_ID,
        thread_ts: THREAD_TS,
        text: "On it 👀",
        metadata: {
          event_type: "vandura_session",
          event_payload: {
            sessionId: SESSION_ID,
            pendingApproval: null,
            botEngaged: true,
          },
        },
      });
    });

    it("returns the firstMessageTs from Slack", async () => {
      slack.postMessage.mockResolvedValueOnce({ ts: "1700000001.000001" });

      const result = await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);
      expect(result.firstMessageTs).toBe("1700000001.000001");
    });

    it("uses custom sessionTtl when provided", async () => {
      const customStore = createStore(redis, slack, { sessionTtl: 3600 });
      await customStore.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      expect(redis.set).toHaveBeenCalledWith(
        `thread:${CHANNEL_ID}:${THREAD_TS}`,
        SESSION_ID,
        "EX",
        3600
      );
    });
  });

  describe("resolve", () => {
    it("returns session ID from Redis on cache hit", async () => {
      redis.store.set(`thread:${CHANNEL_ID}:${THREAD_TS}`, SESSION_ID);

      const result = await store.resolve(CHANNEL_ID, THREAD_TS);
      expect(result).toBe(SESSION_ID);
    });

    it("does not call Slack on Redis hit", async () => {
      redis.store.set(`thread:${CHANNEL_ID}:${THREAD_TS}`, SESSION_ID);

      await store.resolve(CHANNEL_ID, THREAD_TS);
      expect(slack.conversationsReplies).not.toHaveBeenCalled();
    });

    it("falls back to Slack on Redis miss and rehydrates Redis", async () => {
      slack.conversationsReplies.mockResolvedValueOnce({
        messages: [
          {
            user: BOT_USER_ID,
            ts: "1700000001.000001",
            metadata: {
              event_type: "vandura_session",
              event_payload: {
                sessionId: SESSION_ID,
                pendingApproval: null,
              },
            },
          },
        ],
      });

      const result = await store.resolve(CHANNEL_ID, THREAD_TS);
      expect(result).toBe(SESSION_ID);

      // Should rehydrate Redis
      expect(redis.set).toHaveBeenCalledWith(
        `thread:${CHANNEL_ID}:${THREAD_TS}`,
        SESSION_ID,
        "EX",
        7 * 24 * 3600
      );
      expect(redis.hset).toHaveBeenCalledWith(
        `session:${SESSION_ID}`,
        "pendingApproval",
        "null"
      );
    });

    it("rehydrates pending approval from Slack metadata (without toolInput)", async () => {
      slack.conversationsReplies.mockResolvedValueOnce({
        messages: [
          {
            user: BOT_USER_ID,
            ts: "1700000001.000001",
            metadata: {
              event_type: "vandura_session",
              event_payload: {
                sessionId: SESSION_ID,
                pendingApproval: {
                  toolName: "db_write",
                  tier: 3,
                  toolUseId: "tu_123",
                },
              },
            },
          },
        ],
      });

      const result = await store.resolve(CHANNEL_ID, THREAD_TS);
      expect(result).toBe(SESSION_ID);

      // Should rehydrate with empty toolInput
      expect(redis.hset).toHaveBeenCalledWith(
        `session:${SESSION_ID}`,
        "pendingApproval",
        JSON.stringify({
          toolName: "db_write",
          tier: 3,
          toolUseId: "tu_123",
          toolInput: {},
        })
      );
    });

    it("returns null when nothing found in Redis or Slack", async () => {
      slack.conversationsReplies.mockResolvedValueOnce({ messages: [] });

      const result = await store.resolve(CHANNEL_ID, THREAD_TS);
      expect(result).toBeNull();
    });

    it("returns null when Slack has messages but none from the bot", async () => {
      slack.conversationsReplies.mockResolvedValueOnce({
        messages: [
          { user: "U_OTHER", ts: "1700000001.000001", text: "hello" },
        ],
      });

      const result = await store.resolve(CHANNEL_ID, THREAD_TS);
      expect(result).toBeNull();
    });

    it("calls conversationsReplies with correct parameters", async () => {
      slack.conversationsReplies.mockResolvedValueOnce({ messages: [] });

      await store.resolve(CHANNEL_ID, THREAD_TS);

      expect(slack.conversationsReplies).toHaveBeenCalledWith({
        channel: CHANNEL_ID,
        ts: THREAD_TS,
        limit: 10,
        include_all_metadata: true,
      });
    });
  });

  describe("sandboxPath", () => {
    it("derives correct path with default sessionsDir", () => {
      const path = store.sandboxPath(SESSION_ID);
      const home = process.env.HOME || "/root";
      expect(path).toBe(`${home}/.claude/sessions/${SESSION_ID}`);
    });

    it("uses custom sessionsDir when provided", () => {
      const customStore = createStore(redis, slack, {
        sessionsDir: "/tmp/sessions",
      });
      const path = customStore.sandboxPath(SESSION_ID);
      expect(path).toBe(`/tmp/sessions/${SESSION_ID}`);
    });
  });

  describe("setPendingApproval", () => {
    const approval: PendingApproval = {
      toolName: "db_write",
      tier: 3,
      toolUseId: "tu_456",
      toolInput: { query: "DROP TABLE users" },
    };

    it("stores approval JSON in Redis session hash", async () => {
      // Create first so the message ts is cached
      await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      await store.setPendingApproval(
        SESSION_ID,
        CHANNEL_ID,
        THREAD_TS,
        approval
      );

      expect(redis.hset).toHaveBeenCalledWith(
        `session:${SESSION_ID}`,
        "pendingApproval",
        JSON.stringify(approval)
      );
    });

    it("updates Slack message metadata (without toolInput)", async () => {
      await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      await store.setPendingApproval(
        SESSION_ID,
        CHANNEL_ID,
        THREAD_TS,
        approval
      );

      expect(slack.updateMessage).toHaveBeenCalledWith({
        channel: CHANNEL_ID,
        ts: "1234567890.000001", // from mock postMessage
        text: "On it 👀",
        metadata: {
          event_type: "vandura_session",
          event_payload: {
            sessionId: SESSION_ID,
            pendingApproval: {
              toolName: "db_write",
              tier: 3,
              toolUseId: "tu_456",
            },
            botEngaged: true,
          },
        },
      });
    });
  });

  describe("getPendingApproval", () => {
    it("returns parsed PendingApproval from Redis", async () => {
      const approval: PendingApproval = {
        toolName: "shell",
        tier: 2,
        toolUseId: "tu_789",
        toolInput: { command: "ls" },
      };

      // Manually set in mock store
      redis.hashStore.set(
        `session:${SESSION_ID}`,
        new Map([["pendingApproval", JSON.stringify(approval)]])
      );

      const result = await store.getPendingApproval(SESSION_ID);
      expect(result).toEqual(approval);
    });

    it("returns null when pendingApproval is 'null' string", async () => {
      redis.hashStore.set(
        `session:${SESSION_ID}`,
        new Map([["pendingApproval", "null"]])
      );

      const result = await store.getPendingApproval(SESSION_ID);
      expect(result).toBeNull();
    });

    it("returns null when session does not exist", async () => {
      const result = await store.getPendingApproval(SESSION_ID);
      expect(result).toBeNull();
    });
  });

  describe("resolvePendingApproval", () => {
    it("clears pending approval in Redis", async () => {
      await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      await store.resolvePendingApproval(
        SESSION_ID,
        CHANNEL_ID,
        THREAD_TS,
        "allow",
        "U_APPROVER"
      );

      expect(redis.hdel).toHaveBeenCalledWith(
        `session:${SESSION_ID}`,
        "pendingApproval"
      );
    });

    it("updates Slack metadata with null pendingApproval", async () => {
      await store.create(SESSION_ID, CHANNEL_ID, THREAD_TS);

      await store.resolvePendingApproval(
        SESSION_ID,
        CHANNEL_ID,
        THREAD_TS,
        "deny",
        "U_APPROVER"
      );

      expect(slack.updateMessage).toHaveBeenCalledWith({
        channel: CHANNEL_ID,
        ts: "1234567890.000001",
        text: "On it 👀",
        metadata: {
          event_type: "vandura_session",
          event_payload: {
            sessionId: SESSION_ID,
            pendingApproval: null,
            botEngaged: true,
          },
        },
      });
    });
  });

  describe("updateSlackMetadata (via setPendingApproval without cached ts)", () => {
    it("looks up first bot message when ts is not cached", async () => {
      // Don't call create — so ts is not cached
      slack.conversationsReplies.mockResolvedValueOnce({
        messages: [
          {
            user: BOT_USER_ID,
            ts: "1700000099.000099",
            metadata: {
              event_type: "vandura_session",
              event_payload: { sessionId: SESSION_ID },
            },
          },
        ],
      });

      const approval: PendingApproval = {
        toolName: "shell",
        tier: 2,
        toolUseId: "tu_lookup",
        toolInput: {},
      };

      await store.setPendingApproval(
        SESSION_ID,
        CHANNEL_ID,
        THREAD_TS,
        approval
      );

      expect(slack.conversationsReplies).toHaveBeenCalled();
      expect(slack.updateMessage).toHaveBeenCalledWith(
        expect.objectContaining({ ts: "1700000099.000099" })
      );
    });
  });
});
