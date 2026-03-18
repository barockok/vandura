import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createSlackUploadServer,
  uploadFileToSlack,
} from "../../src/tools/slack-upload-file.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
const mockReadFile = vi.mocked(readFile);

describe("createSlackUploadServer", () => {
  const mockSlackClient = {
    filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
  };

  it("returns an SDK MCP server config with correct type and name", () => {
    const server = createSlackUploadServer({
      slackClient: mockSlackClient,
      channelId: "C123",
      threadTs: "1234.5678",
    });

    expect(server).toBeDefined();
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("slack-upload");
    expect(server.instance).toBeDefined();
  });

  it("creates server without threadTs", () => {
    const server = createSlackUploadServer({
      slackClient: mockSlackClient,
      channelId: "C123",
    });

    expect(server).toBeDefined();
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("slack-upload");
  });
});

describe("uploadFileToSlack", () => {
  let mockSlackClient: { filesUploadV2: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSlackClient = {
      filesUploadV2: vi.fn().mockResolvedValue({ ok: true }),
    };
    vi.clearAllMocks();
  });

  it("uploads text content as string (not Buffer)", async () => {
    const result = await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C123", threadTs: "1234.5678" },
      { filename: "report.csv", content: "a,b,c\n1,2,3" },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Uploaded report.csv to Slack thread.");

    expect(mockSlackClient.filesUploadV2).toHaveBeenCalledWith({
      channel_id: "C123",
      thread_ts: "1234.5678",
      filename: "report.csv",
      content: "a,b,c\n1,2,3",
      title: "report.csv",
    });
  });

  it("uploads base64-encoded content as Buffer via file param", async () => {
    const originalContent = "hello binary world";
    const base64Content = Buffer.from(originalContent).toString("base64");

    const result = await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C456" },
      { filename: "image.png", content: base64Content, is_base64: true },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Uploaded image.png to Slack thread.");

    const callArgs = mockSlackClient.filesUploadV2.mock.calls[0][0];
    expect(callArgs.file).toEqual(Buffer.from(originalContent));
    expect(callArgs.content).toBeUndefined();
    expect(callArgs.thread_ts).toBeUndefined();
  });

  it("omits thread_ts when not provided", async () => {
    await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C456" },
      { filename: "data.csv", content: "x" },
    );

    const callArgs = mockSlackClient.filesUploadV2.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("thread_ts");
  });

  it("uploads from file_path by reading from disk", async () => {
    const fileBuffer = Buffer.from("id,name\n1,Acme\n2,Beta");
    mockReadFile.mockResolvedValue(fileBuffer);

    const result = await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C123", threadTs: "1234.5678" },
      { filename: "export.csv", file_path: "/sandbox/export.csv" },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("Uploaded export.csv to Slack thread.");

    expect(mockReadFile).toHaveBeenCalledWith("/sandbox/export.csv");
    expect(mockSlackClient.filesUploadV2).toHaveBeenCalledWith({
      channel_id: "C123",
      thread_ts: "1234.5678",
      filename: "export.csv",
      file: fileBuffer,
      title: "export.csv",
    });
  });

  it("file_path takes precedence over content", async () => {
    const fileBuffer = Buffer.from("from disk");
    mockReadFile.mockResolvedValue(fileBuffer);

    await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C123" },
      { filename: "data.csv", content: "from content", file_path: "/sandbox/data.csv" },
    );

    const callArgs = mockSlackClient.filesUploadV2.mock.calls[0][0];
    expect(callArgs.file).toEqual(fileBuffer);
    expect(callArgs.content).toBeUndefined();
  });

  it("returns error when neither content nor file_path provided", async () => {
    const result = await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C123" },
      { filename: "empty.csv" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("either content or file_path must be provided");
    expect(mockSlackClient.filesUploadV2).not.toHaveBeenCalled();
  });

  it("returns error when file_path read fails", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

    const result = await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C123" },
      { filename: "missing.csv", file_path: "/sandbox/missing.csv" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Failed to upload missing.csv: ENOENT: no such file");
  });

  it("uses custom title when provided", async () => {
    await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C123" },
      { filename: "data.json", content: "{}", title: "Customer Export" },
    );

    const callArgs = mockSlackClient.filesUploadV2.mock.calls[0][0];
    expect(callArgs.title).toBe("Customer Export");
  });

  it("defaults title to filename when not provided", async () => {
    await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C123" },
      { filename: "data.json", content: "{}" },
    );

    const callArgs = mockSlackClient.filesUploadV2.mock.calls[0][0];
    expect(callArgs.title).toBe("data.json");
  });

  it("returns error result when Slack API fails", async () => {
    mockSlackClient.filesUploadV2.mockRejectedValue(new Error("channel_not_found"));

    const result = await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C999" },
      { filename: "fail.txt", content: "oops" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Failed to upload fail.txt: channel_not_found",
    );
  });

  it("handles non-Error exceptions gracefully", async () => {
    mockSlackClient.filesUploadV2.mockRejectedValue("string error");

    const result = await uploadFileToSlack(
      { slackClient: mockSlackClient, channelId: "C999" },
      { filename: "fail.txt", content: "oops" },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Failed to upload fail.txt: unknown error",
    );
  });
});
