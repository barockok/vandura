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

  async execute(input: {
    filename: string;
    content: string;
    content_type: string;
  }): Promise<{ signedUrl: string }> {
    const key = `${this.taskId}/${input.filename}`;
    const { signedUrl } = await this.storage.upload({
      key,
      content: Buffer.from(input.content),
      contentType: input.content_type,
    });
    return { signedUrl };
  }
}
