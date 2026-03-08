import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Session, SessionStatus } from "../queue/types.js";
import { pool } from "../db/pool.js";

/**
 * Base directory for session sandboxes
 * Defaults to ~/.claude/sessions
 */
const SESSIONS_BASE_DIR = process.env.CLAUDE_SESSIONS_DIR || join(homedir(), ".claude", "sessions");

/**
 * Create a new session with sandbox directory
 */
export async function createSession(params: {
  channelId: string;
  userId: string;
  threadTs?: string;
}): Promise<Session> {
  const id = randomUUID();
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Date-partitioned sandbox path
  const sandboxPath = join(SESSIONS_BASE_DIR, date, id);

  // Create sandbox directories
  await mkdir(join(sandboxPath, "workspace"), { recursive: true });

  // Insert into database
  const result = await pool.query<{
    id: string;
    channel_id: string;
    user_id: string;
    thread_ts: string | null;
    sandbox_path: string;
    status: SessionStatus;
    created_at: Date;
    updated_at: Date;
  }>(
    `INSERT INTO sessions (id, channel_id, user_id, thread_ts, sandbox_path, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, params.channelId, params.userId, params.threadTs || null, sandboxPath, "active"]
  );

  const row = result.rows[0];

  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    threadTs: row.thread_ts,
    sandboxPath: row.sandbox_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Row type returned by session queries
 */
interface SessionRow {
  id: string;
  channel_id: string;
  user_id: string;
  thread_ts: string | null;
  sandbox_path: string;
  status: SessionStatus;
  created_at: Date;
  updated_at: Date;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    threadTs: row.thread_ts,
    sandboxPath: row.sandbox_path,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get a session by ID
 */
export async function getSession(sessionId: string): Promise<Session | null> {
  const result = await pool.query<SessionRow>(
    `SELECT * FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return rowToSession(result.rows[0]);
}

/**
 * Get a session by channel and thread timestamp
 */
export async function getSessionByThread(channelId: string, threadTs: string): Promise<Session | null> {
  const result = await pool.query<SessionRow>(
    `SELECT * FROM sessions WHERE channel_id = $1 AND thread_ts = $2 ORDER BY created_at DESC LIMIT 1`,
    [channelId, threadTs]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return rowToSession(result.rows[0]);
}

/**
 * Update session status
 */
export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, sessionId]
  );
}

/**
 * Delete a session and its sandbox directory
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);

  if (session) {
    // Remove sandbox directory
    try {
      await rm(session.sandboxPath, { recursive: true, force: true });
    } catch (error) {
      console.error(`[Session] Failed to delete sandbox ${session.sandboxPath}:`, error);
    }

    // Delete from database
    await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  }
}

/**
 * Clean up old sessions (older than specified days)
 */
export async function cleanupOldSessions(daysOld: number = 7): Promise<number> {
  const result = await pool.query<{
    id: string;
    sandbox_path: string;
  }>(
    `SELECT id, sandbox_path FROM sessions
     WHERE created_at < NOW() - INTERVAL '${daysOld} days'
     AND status IN ('completed', 'failed')`
  );

  for (const row of result.rows) {
    try {
      await rm(row.sandbox_path, { recursive: true, force: true });
    } catch (error) {
      console.error(`[Session] Failed to delete sandbox ${row.sandbox_path}:`, error);
    }
  }

  const deleteResult = await pool.query(
    `DELETE FROM sessions
     WHERE created_at < NOW() - INTERVAL '${daysOld} days'
     AND status IN ('completed', 'failed')`
  );

  return deleteResult.rowCount || 0;
}