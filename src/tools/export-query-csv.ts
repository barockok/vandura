import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { z } from "zod";

interface ExportQueryOptions {
  connectionUrl: string;
}

type ExportResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Run a SELECT query and write results directly to a CSV file on disk.
 * Returns row count, columns, file size, and a sample preview — data never enters LLM context in bulk.
 */
export async function exportQueryToCsv(
  options: ExportQueryOptions,
  args: {
    query: string;
    output_path: string;
  },
): Promise<ExportResult> {
  // Only allow SELECT / WITH queries
  const trimmed = args.query.trim().toUpperCase();
  if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
    return {
      content: [{ type: "text" as const, text: "Only SELECT or WITH queries are allowed for CSV export." }],
      isError: true,
    };
  }

  const pool = new Pool({ connectionString: options.connectionUrl });
  try {
    const result = await pool.query(args.query);
    const rows = result.rows;
    const fields = result.fields.map((f) => f.name);

    if (rows.length === 0) {
      return {
        content: [{ type: "text" as const, text: `Query returned 0 rows. No file written.` }],
      };
    }

    // Build CSV in memory and write to disk
    const escapeCsv = (val: unknown): string => {
      if (val === null || val === undefined) return "";
      const str = String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const header = fields.map(escapeCsv).join(",");
    const lines = rows.map((row) => fields.map((f) => escapeCsv(row[f])).join(","));
    const csv = [header, ...lines].join("\n") + "\n";

    await writeFile(args.output_path, csv, "utf-8");

    const fileSize = Buffer.byteLength(csv, "utf-8");

    // Build a small sample preview (first 5 rows as CSV) for the agent to summarize from
    const sampleLines = lines.slice(0, 5);
    const sampleCsv = [header, ...sampleLines].join("\n");

    return {
      content: [{
        type: "text" as const,
        text: [
          `Exported ${rows.length} rows (${fields.length} columns: ${fields.join(", ")}) to ${args.output_path}`,
          `File size: ${fileSize} bytes`,
          ``,
          `Sample (first ${Math.min(5, rows.length)} rows):`,
          sampleCsv,
        ].join("\n"),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: `Export failed: ${error instanceof Error ? error.message : "unknown error"}`,
      }],
      isError: true,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Create an in-process MCP server with the export_query_to_csv tool.
 */
export function createExportQueryServer(options: ExportQueryOptions) {
  return createSdkMcpServer({
    name: "export-query",
    version: "1.0.0",
    tools: [
      {
        name: "export_query_to_csv",
        description:
          "Run a SQL SELECT query and write results directly to a CSV file on disk. " +
          "Returns row count, column names, file size, and a 5-row sample preview. " +
          "The full dataset never enters the conversation — only metadata and sample. " +
          "ALWAYS use this for any CSV/data export request. " +
          "After exporting, use slack_upload_file with file_path to upload the file.",
        inputSchema: {
          query: z
            .string()
            .describe("SQL SELECT query to export. Only SELECT and WITH statements are allowed."),
          output_path: z
            .string()
            .describe("Absolute path where the CSV file will be written (e.g. /path/to/workspace/export.csv)."),
        },
        handler: async (args: Record<string, unknown>, _extra: unknown) => {
          return exportQueryToCsv(options, {
            query: args.query as string,
            output_path: args.output_path as string,
          });
        },
      },
    ],
  });
}
