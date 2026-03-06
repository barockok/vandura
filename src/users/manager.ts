import type { Pool } from "../db/connection.js";
import type { VanduraUser } from "./types.js";

export class UserManager {
  constructor(private pool: Pool) {}

  async findOrCreate(slackId: string, displayName: string, role: string): Promise<VanduraUser> {
    const result = await this.pool.query(
      `INSERT INTO users (slack_id, display_name, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (slack_id) DO UPDATE SET display_name = COALESCE($2, users.display_name)
       RETURNING *`,
      [slackId, displayName, role],
    );
    return this.rowToUser(result.rows[0]);
  }

  async findBySlackId(slackId: string): Promise<VanduraUser | null> {
    const result = await this.pool.query(
      "SELECT * FROM users WHERE slack_id = $1",
      [slackId],
    );
    if (result.rows.length === 0) return null;
    return this.rowToUser(result.rows[0]);
  }

  async setRole(userId: string, role: string): Promise<VanduraUser> {
    const result = await this.pool.query(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING *",
      [role, userId],
    );
    if (result.rows.length === 0) throw new Error(`User ${userId} not found`);
    return this.rowToUser(result.rows[0]);
  }

  async markOnboarded(userId: string): Promise<VanduraUser> {
    const result = await this.pool.query(
      "UPDATE users SET onboarded_at = now() WHERE id = $1 RETURNING *",
      [userId],
    );
    if (result.rows.length === 0) throw new Error(`User ${userId} not found`);
    return this.rowToUser(result.rows[0]);
  }

  async setToolOverrides(
    userId: string,
    overrides: Record<string, { max_tier?: number; blocked?: boolean }>,
  ): Promise<VanduraUser> {
    const result = await this.pool.query(
      "UPDATE users SET tool_overrides = $1 WHERE id = $2 RETURNING *",
      [JSON.stringify(overrides), userId],
    );
    if (result.rows.length === 0) throw new Error(`User ${userId} not found`);
    return this.rowToUser(result.rows[0]);
  }

  private rowToUser(row: Record<string, unknown>): VanduraUser {
    return {
      id: row.id as string,
      slackId: row.slack_id as string,
      displayName: (row.display_name as string) ?? null,
      role: row.role as string,
      toolOverrides: (row.tool_overrides as Record<string, { max_tier?: number; blocked?: boolean }>) ?? {},
      isActive: row.is_active as boolean,
      onboardedAt: (row.onboarded_at as Date) ?? null,
      createdAt: row.created_at as Date,
    };
  }
}
