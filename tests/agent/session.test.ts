import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the db/pool module before imports
const mockQuery = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// Mock fs
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

import { createSession, getSession, getSessionByThread, updateSessionStatus } from "../../src/agent/session.js";

describe("session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSession", () => {
    it("creates session with UUID and sandbox path", async () => {
      const now = new Date();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "test-uuid",
          channel_id: "C123",
          user_id: "U456",
          thread_ts: "1234567890.123456",
          sandbox_path: "/tmp/sessions/2026-03-08/test-uuid",
          status: "active",
          created_at: now,
          updated_at: now,
        }],
      });

      const session = await createSession({
        channelId: "C123",
        userId: "U456",
        threadTs: "1234567890.123456",
      });

      expect(session.channelId).toBe("C123");
      expect(session.userId).toBe("U456");
      expect(session.threadTs).toBe("1234567890.123456");
      expect(session.status).toBe("active");
    });
  });

  describe("getSession", () => {
    it("returns session by UUID", async () => {
      const now = new Date();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "test-uuid",
          channel_id: "C123",
          user_id: "U456",
          thread_ts: "1234567890.123456",
          sandbox_path: "/tmp/sessions/test",
          status: "active",
          created_at: now,
          updated_at: now,
        }],
      });

      const session = await getSession("test-uuid");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("test-uuid");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("WHERE id = $1"),
        ["test-uuid"],
      );
    });

    it("returns null when session not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const session = await getSession("nonexistent");
      expect(session).toBeNull();
    });
  });

  describe("getSessionByThread", () => {
    it("finds session by channel and thread_ts", async () => {
      const now = new Date();
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: "test-uuid",
          channel_id: "C123",
          user_id: "U456",
          thread_ts: "1234567890.123456",
          sandbox_path: "/tmp/sessions/test",
          status: "active",
          created_at: now,
          updated_at: now,
        }],
      });

      const session = await getSessionByThread("C123", "1234567890.123456");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("test-uuid");
      expect(session!.channelId).toBe("C123");
      expect(session!.threadTs).toBe("1234567890.123456");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("channel_id = $1"),
        expect.arrayContaining(["C123", "1234567890.123456"]),
      );
    });

    it("returns null when no session matches thread", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const session = await getSessionByThread("C123", "nonexistent");
      expect(session).toBeNull();
    });
  });

  describe("updateSessionStatus", () => {
    it("updates status in database", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await updateSessionStatus("test-uuid", "completed");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE sessions SET status"),
        ["completed", "test-uuid"],
      );
    });
  });
});
