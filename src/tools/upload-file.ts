import type { StorageService } from "../storage/s3.js";
import type { ToolDefinition } from "./types.js";

export class UploadFileTool {
  constructor(
    private storage: StorageService,
    private taskId: string,
  ) {}

  definition(): ToolDefinition {
    return {
      name: "upload_file",
      description:
        "Upload content as a downloadable file and return a signed download link. " +
        "Use this when the user asks for a file export (CSV, JSON, etc.) instead of posting the data inline.",
      input_schema: {
        type: "object",
        properties: {
          filename: {
            type: "string",
            description: "The filename including extension (e.g. customers.csv, report.json)",
          },
          content: {
            type: "string",
            description: "The file content as a string",
          },
          content_type: {
            type: "string",
            description: "MIME type (e.g. text/csv, application/json, text/plain)",
          },
        },
        required: ["filename", "content", "content_type"],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<{ signedUrl: string }> {
    // Handle both snake_case and camelCase for content_type
    const filename = input.filename as string;
    const content = input.content as string;
    const contentType = (input.content_type ?? input.contentType) as string;

    if (!content) {
      throw new Error(`upload_file: 'content' is required. Received: ${JSON.stringify(input)}`);
    }
    if (!filename) {
      throw new Error(`upload_file: 'filename' is required. Received: ${JSON.stringify(input)}`);
    }
    if (!contentType) {
      throw new Error(`upload_file: 'content_type' is required. Received: ${JSON.stringify(input)}`);
    }

    const key = `${this.taskId}/${filename}`;
    const { signedUrl } = await this.storage.upload({
      key,
      content: Buffer.from(content),
      contentType,
    });
    return { signedUrl };
  }
}
