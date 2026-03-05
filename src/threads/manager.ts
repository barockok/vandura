import type pg from "pg";
import type { Task, Message } from "./types.js";

export class ThreadManager {
  constructor(private pool: pg.Pool) {}

  async createTask(params: {
    slackThreadTs: string;
    slackChannel: string;
    agentId: string;
    initiatorSlackId: string;
    topic?: string | null;
  }): Promise<Task> {
    const result = await this.pool.query(
      `INSERT INTO tasks (slack_thread_ts, slack_channel, agent_id, initiator_slack_id, topic)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        params.slackThreadTs,
        params.slackChannel,
        params.agentId,
        params.initiatorSlackId,
        params.topic ?? null,
      ]
    );
    return this.rowToTask(result.rows[0]);
  }

  async findByThread(channel: string, threadTs: string): Promise<Task | null> {
    const result = await this.pool.query(
      `SELECT * FROM tasks WHERE slack_channel = $1 AND slack_thread_ts = $2`,
      [channel, threadTs]
    );
    if (result.rows.length === 0) return null;
    return this.rowToTask(result.rows[0]);
  }

  async setChecker(taskId: string, checkerSlackId: string): Promise<Task> {
    const result = await this.pool.query(
      `UPDATE tasks SET checker_slack_id = $1 WHERE id = $2 RETURNING *`,
      [checkerSlackId, taskId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Task ${taskId} not found`);
    }
    return this.rowToTask(result.rows[0]);
  }

  async addMessage(
    taskId: string,
    role: Message["role"],
    content: string,
    metadata?: Record<string, unknown> | null
  ): Promise<Message> {
    const result = await this.pool.query(
      `INSERT INTO messages (task_id, role, content, metadata)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [taskId, role, content, metadata ? JSON.stringify(metadata) : null]
    );
    return this.rowToMessage(result.rows[0]);
  }

  async getMessages(taskId: string): Promise<Message[]> {
    const result = await this.pool.query(
      `SELECT * FROM messages WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map((row: Record<string, unknown>) => this.rowToMessage(row));
  }

  async closeTask(
    taskId: string,
    status: "completed" | "cancelled"
  ): Promise<Task> {
    const result = await this.pool.query(
      `UPDATE tasks SET status = $1, closed_at = now() WHERE id = $2 RETURNING *`,
      [status, taskId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Task ${taskId} not found`);
    }
    return this.rowToTask(result.rows[0]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rowToTask(row: any): Task {
    return {
      id: row.id,
      slackThreadTs: row.slack_thread_ts,
      slackChannel: row.slack_channel,
      agentId: row.agent_id,
      initiatorSlackId: row.initiator_slack_id,
      checkerSlackId: row.checker_slack_id ?? null,
      topic: row.topic ?? null,
      status: row.status,
      createdAt: row.created_at,
      closedAt: row.closed_at ?? null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      taskId: row.task_id,
      role: row.role,
      content: row.content,
      metadata: row.metadata ?? null,
      createdAt: row.created_at,
    };
  }
}
