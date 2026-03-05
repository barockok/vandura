import type { Pool } from "../db/connection.js";

interface LogEntry {
  taskId?: string;
  agentId?: string;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  task_id: string | null;
  agent_id: string | null;
  action: string;
  actor: string;
  detail: Record<string, unknown>;
  created_at: Date;
}

export class AuditLogger {
  constructor(private pool: Pool) {}

  async log(entry: LogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_log (task_id, agent_id, action, actor, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.taskId ?? null, entry.agentId ?? null, entry.action, entry.actor, JSON.stringify(entry.detail)]
    );
  }

  async getByActor(actor: string): Promise<AuditRow[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_log WHERE actor = $1 ORDER BY created_at DESC",
      [actor]
    );
    return result.rows;
  }

  async getByTaskId(taskId: string): Promise<AuditRow[]> {
    const result = await this.pool.query(
      "SELECT * FROM audit_log WHERE task_id = $1 ORDER BY created_at DESC",
      [taskId]
    );
    return result.rows;
  }
}
