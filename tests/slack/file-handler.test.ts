import { describe, it, expect, vi, beforeEach } from "vitest";
import { processFileAttachments, type SlackFile } from "../../src/slack/file-handler.js";

// Mock fs/promises to avoid actual file writes
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

describe("processFileAttachments", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  it("returns empty result when no files", async () => {
    const result = await processFileAttachments({
      files: [],
      sandboxPath: "/tmp/test",
      botToken: "xoxb-test",
    });
    expect(result.savedFiles).toEqual([]);
    expect(result.imageContents).toEqual([]);
    expect(result.textAnnotations).toEqual([]);
  });

  it("downloads and saves a CSV file", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from("id,name\n1,Alice")),
    });

    const files: SlackFile[] = [{
      id: "F123",
      name: "data.csv",
      mimetype: "text/csv",
      url_private_download: "https://files.slack.com/files/data.csv",
      size: 15,
    }];

    const result = await processFileAttachments({
      files,
      sandboxPath: "/tmp/test",
      botToken: "xoxb-test",
    });

    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]).toContain("data.csv");
    expect(result.textAnnotations).toHaveLength(1);
    expect(result.textAnnotations[0]).toContain("data.csv");
    expect(result.imageContents).toHaveLength(0);
  });

  it("saves image and creates vision content block", async () => {
    const pngBuffer = Buffer.from("fake-png-data");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(pngBuffer),
    });

    const files: SlackFile[] = [{
      id: "F456",
      name: "screenshot.png",
      mimetype: "image/png",
      url_private_download: "https://files.slack.com/files/screenshot.png",
      size: 1000,
    }];

    const result = await processFileAttachments({
      files,
      sandboxPath: "/tmp/test",
      botToken: "xoxb-test",
    });

    expect(result.savedFiles).toHaveLength(1);
    expect(result.imageContents).toHaveLength(1);
    expect(result.imageContents[0]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: pngBuffer.toString("base64"),
      },
    });
    expect(result.textAnnotations[0]).toContain("(attached as image)");
  });

  it("handles multiple files of different types", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from("csv-data")),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from("png-data")),
      });

    const files: SlackFile[] = [
      { id: "F1", name: "data.csv", mimetype: "text/csv", url_private_download: "https://slack/f1", size: 8 },
      { id: "F2", name: "photo.jpg", mimetype: "image/jpeg", url_private_download: "https://slack/f2", size: 8 },
    ];

    const result = await processFileAttachments({
      files,
      sandboxPath: "/tmp/test",
      botToken: "xoxb-test",
    });

    expect(result.savedFiles).toHaveLength(2);
    expect(result.imageContents).toHaveLength(1);
    expect(result.textAnnotations).toHaveLength(2);
  });

  it("handles download failure gracefully", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const files: SlackFile[] = [{
      id: "F789",
      name: "secret.pdf",
      mimetype: "application/pdf",
      url_private_download: "https://files.slack.com/files/secret.pdf",
      size: 1000,
    }];

    const result = await processFileAttachments({
      files,
      sandboxPath: "/tmp/test",
      botToken: "xoxb-test",
    });

    expect(result.savedFiles).toHaveLength(0);
    expect(result.textAnnotations[0]).toContain("failed to download");
  });
});
