import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

interface SlackUploadOptions {
  slackClient: {
    filesUploadV2: (params: Record<string, unknown>) => Promise<unknown>;
  };
  channelId: string;
  threadTs?: string;
}

/**
 * Upload a file to a Slack channel/thread using the Slack Web API.
 * Extracted so it can be tested independently of the MCP server wrapper.
 */
export async function uploadFileToSlack(
  options: SlackUploadOptions,
  args: {
    filename: string;
    content: string;
    content_type?: string;
    title?: string;
    is_base64?: boolean;
  },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const buffer = args.is_base64
      ? Buffer.from(args.content, "base64")
      : Buffer.from(args.content);

    await options.slackClient.filesUploadV2({
      channel_id: options.channelId,
      thread_ts: options.threadTs,
      filename: args.filename,
      content: buffer,
      title: args.title || args.filename,
    });

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
          "The file appears as a native Slack attachment with preview and download.",
        inputSchema: {
          filename: z
            .string()
            .describe("Filename with extension (e.g. report.csv, chart.png)"),
          content: z
            .string()
            .describe(
              "File content as a string. For binary files, use base64 and set is_base64 to true.",
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
            .describe("Set to true if content is base64-encoded binary data."),
        },
        handler: async (args: Record<string, unknown>, _extra: unknown) => {
          return uploadFileToSlack(options, {
            filename: args.filename as string,
            content: args.content as string,
            content_type: args.content_type as string | undefined,
            title: args.title as string | undefined,
            is_base64: args.is_base64 as boolean | undefined,
          });
        },
      },
    ],
  });
}
