import type { Pool } from "../db/connection.js";
import type { ToolDefinition } from "./types.js";

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  error?: string;
}

export interface ExplainResult {
  plan: string;
  estimatedRows: number;
}

export class PostgresTool {
  constructor(private pool: Pool) {}

  async execute(input: { sql: string }): Promise<QueryResult> {
    try {
      const result = await this.pool.query(input.sql);
      const columns = result.fields?.map((f: { name: string }) => f.name) ?? [];
      return {
        rows: result.rows ?? [],
        columns,
        rowCount: result.rowCount ?? 0,
      };
    } catch (err) {
      return {
        rows: [],
        columns: [],
        rowCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async explain(sql: string): Promise<ExplainResult> {
    const result = await this.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    const planJson = result.rows[0]?.["QUERY PLAN"] ?? [];
    const plan = JSON.stringify(planJson, null, 2);
    const estimatedRows = planJson[0]?.Plan?.["Plan Rows"] ?? 0;
    return { plan, estimatedRows };
  }

  definition(): ToolDefinition {
    return {
      name: "db_query",
      description:
        "Execute a read-only SQL query against the Postgres database. Use this for SELECT queries. For write operations, use db_write.",
      input_schema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "The SQL query to execute. Must be a valid PostgreSQL query.",
          },
        },
        required: ["sql"],
      },
    };
  }
}
