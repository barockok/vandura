import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { z } from "zod";

interface SlackUploadOptions {
  slackClient: {
    filesUploadV2: (params: Record<string, unknown>) => Promise<unknown>;
  };
  channelId: string;
  threadTs?: string;
}

type UploadResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Upload a file to a Slack channel/thread using the Slack Web API.
 * Supports two modes:
 *   - content mode: pass file content directly as a string (small files)
 *   - file_path mode: read from disk and upload (large files, avoids LLM context)
 */
export async function uploadFileToSlack(
  options: SlackUploadOptions,
  args: {
    filename: string;
    content?: string;
    file_path?: string;
    content_type?: string;
    title?: string;
    is_base64?: boolean;
  },
): Promise<UploadResult> {
  try {
    if (!args.content && !args.file_path) {
      return {
        content: [{ type: "text" as const, text: `Failed to upload ${args.filename}: either content or file_path must be provided.` }],
        isError: true,
      };
    }

    const uploadParams: Record<string, unknown> = {
      channel_id: options.channelId,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      filename: args.filename,
      title: args.title || args.filename,
    };

    if (args.file_path) {
      // Read from disk — content never enters LLM context
      uploadParams.file = await readFile(args.file_path);
    } else if (args.is_base64) {
      uploadParams.file = Buffer.from(args.content!, "base64");
    } else {
      uploadParams.content = args.content;
    }

    await options.slackClient.filesUploadV2(uploadParams);

    return {
      content: [{ type: "text" as const, text: `Uploaded ${args.filename} to Slack thread.` }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to upload ${args.filename}: ${error instanceof Error ? error.message : "unknown error"}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Create an in-process MCP server with the slack_upload_file tool.
 */
export function createSlackUploadServer(options: SlackUploadOptions) {
  return createSdkMcpServer({
    name: "slack-upload",
    version: "1.0.0",
    tools: [
      {
        name: "slack_upload_file",
        description:
          "Upload a file directly to the current Slack thread. " +
          "Use this for sharing generated files (CSV, JSON, images, etc.) with the team. " +
          "The file appears as a native Slack attachment with preview and download. " +
          "For large files, use file_path to upload from disk without loading content into memory.",
        inputSchema: {
          filename: z
            .string()
            .describe("Filename with extension (e.g. report.csv, chart.png)"),
          content: z
            .string()
            .optional()
            .describe(
              "File content as a string. Use this for small files. For binary files, use base64 and set is_base64 to true. Mutually exclusive with file_path.",
            ),
          file_path: z
            .string()
            .optional()
            .describe(
              "Absolute path to a file on disk to upload. Use this for large files (e.g. exports with many rows) to avoid loading content into the conversation. Mutually exclusive with content.",
            ),
          content_type: z
            .string()
            .optional()
            .describe(
              "MIME type (e.g. text/csv, application/json). Defaults to application/octet-stream.",
            ),
          title: z
            .string()
            .optional()
            .describe("Display title in Slack. Defaults to filename."),
          is_base64: z
            .boolean()
            .optional()
            .describe("Set to true if content is base64-encoded binary data. Only used with content, not file_path."),
        },
        handler: async (args: Record<string, unknown>, _extra: unknown) => {
          return uploadFileToSlack(options, {
            filename: args.filename as string,
            content: args.content as string | undefined,
            file_path: args.file_path as string | undefined,
            content_type: args.content_type as string | undefined,
            title: args.title as string | undefined,
            is_base64: args.is_base64 as boolean | undefined,
          });
        },
      },
    ],
  });
}
