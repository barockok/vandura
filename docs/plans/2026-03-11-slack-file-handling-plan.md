# Slack File Handling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Two independent features: (1) `slack_upload_file` tool for the AI agent to upload files natively to Slack threads, and (2) a handler for user file attachments that saves them to sandbox and passes images as vision input.

**Architecture:** Feature 1 uses `createSdkMcpServer` from the Claude Agent SDK to register a custom in-process MCP tool that calls Slack's `files.uploadV2` API. Feature 2 modifies the gateway and worker to detect file attachments, download them to the session sandbox, and pass images as base64 vision content blocks to the SDK.

**Tech Stack:** TypeScript, Slack Bolt (`@slack/bolt`), Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Vitest

---

### Task 1: `slack_upload_file` Tool — Implementation

**Files:**
- Create: `src/tools/slack-upload-file.ts`
- Test: `tests/tools/slack-upload-file.test.ts`

**Step 1: Write the failing tests**

Create `tests/tools/slack-upload-file.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlackUploadServer } from "../../src/tools/slack-upload-file.js";

describe("createSlackUploadServer", () => {
  const mockUploadV2 = vi.fn().mockResolvedValue({ ok: true, files: [{ permalink: "https://slack.com/files/test" }] });
  const mockSlackClient = {
    filesUploadV2: mockUploadV2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an McpSdkServerConfigWithInstance with the tool registered", () => {
    const server = createSlackUploadServer({
      slackClient: mockSlackClient as any,
      channelId: "C123",
      threadTs: "1234.5678",
    });
    expect(server).toBeDefined();
  });

  it("uploads text content to the correct channel and thread", async () => {
    const server = createSlackUploadServer({
      slackClient: mockSlackClient as any,
      channelId: "C123",
      threadTs: "1234.5678",
    });

    // Extract the handler from the server's tool definition
    const tool = server._serverInstance._tools[0];
    const result = await tool.handler({
      filename: "report.csv",
      content: "id,name\n1,Alice",
      content_type: "text/csv",
    }, {});

    expect(mockUploadV2).toHaveBeenCalledWith({
      channel_id: "C123",
      thread_ts: "1234.5678",
      filename: "report.csv",
      content: Buffer.from("id,name\n1,Alice"),
      title: "report.csv",
    });
    expect(result.content[0].text).toContain("report.csv");
  });

  it("uses title when provided", async () => {
    const server = createSlackUploadServer({
      slackClient: mockSlackClient as any,
      channelId: "C123",
      threadTs: "1234.5678",
    });

    const tool = server._serverInstance._tools[0];
    await tool.handler({
      filename: "data.json",
      content: "{}",
      title: "Monthly Report",
    }, {});

    expect(mockUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Monthly Report" })
    );
  });

  it("handles base64 content", async () => {
    const server = createSlackUploadServer({
      slackClient: mockSlackClient as any,
      channelId: "C123",
      threadTs: "1234.5678",
    });

    const tool = server._serverInstance._tools[0];
    const b64 = Buffer.from("hello").toString("base64");
    await tool.handler({
      filename: "binary.bin",
      content: b64,
      content_type: "application/octet-stream",
      is_base64: true,
    }, {});

    expect(mockUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        content: Buffer.from("hello"),
        filename: "binary.bin",
      })
    );
  });

  it("returns error when upload fails", async () => {
    mockUploadV2.mockRejectedValueOnce(new Error("Slack API error"));

    const server = createSlackUploadServer({
      slackClient: mockSlackClient as any,
      channelId: "C123",
      threadTs: "1234.5678",
    });

    const tool = server._serverInstance._tools[0];
    const result = await tool.handler({
      filename: "fail.txt",
      content: "test",
    }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to upload");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/slack-upload-file.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the tool**

Create `src/tools/slack-upload-file.ts`:

```typescript
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
 * Create an in-process MCP server with the slack_upload_file tool.
 * This lets the AI agent upload files natively to the Slack thread.
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
          filename: z.string().describe("Filename with extension (e.g. report.csv, chart.png)"),
          content: z.string().describe("File content as a string. For binary files, use base64 and set is_base64 to true."),
          content_type: z.string().optional().describe("MIME type (e.g. text/csv, application/json). Defaults to application/octet-stream."),
          title: z.string().optional().describe("Display title in Slack. Defaults to filename."),
          is_base64: z.boolean().optional().describe("Set to true if content is base64-encoded binary data."),
        },
        handler: async (args, _extra) => {
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
              content: [{ type: "text" as const, text: `Failed to upload ${args.filename}: ${error instanceof Error ? error.message : "unknown error"}` }],
              isError: true,
            };
          }
        },
      },
    ],
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tools/slack-upload-file.test.ts`
Expected: PASS (tests may need minor adjustments to match actual SDK MCP server internals — adapt assertions to the real shape returned by `createSdkMcpServer`)

**Step 5: Commit**

```bash
git add src/tools/slack-upload-file.ts tests/tools/slack-upload-file.test.ts
git commit -m "feat: add slack_upload_file tool for native Slack file uploads"
```

---

### Task 2: Wire `slack_upload_file` into SDK Runtime

**Files:**
- Modify: `src/agent/sdk-runtime.ts`
- Modify: `src/queue/worker.ts`

**Step 1: Modify sdk-runtime to accept and register the MCP server**

In `src/agent/sdk-runtime.ts`, update `createQueryOptions` to accept an optional `mcpSdkServers` parameter and pass it to the `mcpServers` option:

```typescript
// Add to imports
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

// Update createQueryOptions signature to add sdkMcpServers parameter
export function createQueryOptions(
  session: Session,
  mcpConfig: LoadedMcpConfig,
  agentConfig?: AgentConfig,
  isResuming: boolean = false,
  mcpConfigPath?: string,
  sdkMcpServers?: Record<string, McpSdkServerConfigWithInstance>,
): Options {
  // ... existing code ...

  const queryOptions: Options = {
    cwd: session.sandboxPath,
    ...(mcpConfigPath ? { extraArgs: { "mcp-config": mcpConfigPath } } : {}),
    // Register in-process SDK MCP servers (slack_upload_file, etc.)
    ...(sdkMcpServers && Object.keys(sdkMcpServers).length > 0
      ? { mcpServers: sdkMcpServers }
      : {}),
    // ... rest of existing options ...
  };
```

Update `runSession` and `continueSession` signatures to accept and pass through `sdkMcpServers`.

**Step 2: Modify worker to create the slack upload server per session**

In `src/queue/worker.ts`, import and instantiate the server:

```typescript
import { createSlackUploadServer } from "../tools/slack-upload-file.js";

// In processStartSession, after creating the session:
const slackUploadServer = createSlackUploadServer({
  slackClient: {
    filesUploadV2: (params) => slackApp.client.files.uploadV2(params),
  },
  channelId: session.channelId,
  threadTs: session.threadTs || undefined,
});

// Pass to runSession
const result = await runSession(
  session,
  message,
  mcpConfig,
  (msg) => sendToSlack(session, msg),
  agentCfg || undefined,
  { "slack-upload": slackUploadServer },
);
```

Do the same in `processContinueSession`.

The worker needs access to the Slack Bolt app's `client`. Modify `setSlackClient` to also accept a `filesUploadV2` function, or pass the full Slack `WebClient`.

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All existing tests still pass

**Step 4: Commit**

```bash
git add src/agent/sdk-runtime.ts src/queue/worker.ts
git commit -m "feat: wire slack_upload_file MCP server into SDK runtime"
```

---

### Task 3: Register `slack_upload_file` in Tool Policies and System Prompt

**Files:**
- Modify: `config/tool-policies.yml`
- Modify: `src/agent/prompt.ts`

**Step 1: Add to tool-policies.yml**

```yaml
  slack_upload_file:
    tier: 1
    connection_type: shared
    guardrails: |
      Upload files to the Slack thread when user requests file exports.
      Prefer this over upload_file for Slack conversations.
      Use appropriate filenames with correct extensions.
```

**Step 2: Update system prompt in `src/agent/prompt.ts`**

Replace the formatting section's file upload guidance:

```typescript
      "When users ask for a file export (CSV, JSON, etc.), use the slack_upload_file tool to upload the file directly to this thread.",
      "Don't dump raw CSV/JSON inline — upload it as a proper file using slack_upload_file.",
      "For large query results (>50 rows), export as a file rather than posting inline.",
```

**Step 3: Run tests**

Run: `npx vitest run tests/agent/prompt.test.ts`
Expected: Update any tests that assert on the old upload_file prompt text

**Step 4: Commit**

```bash
git add config/tool-policies.yml src/agent/prompt.ts tests/agent/prompt.test.ts
git commit -m "feat: register slack_upload_file in tool policies and system prompt"
```

---

### Task 4: File Attachment Handler — Download and Save

**Files:**
- Create: `src/slack/file-handler.ts`
- Test: `tests/slack/file-handler.test.ts`

**Step 1: Write the failing tests**

Create `tests/slack/file-handler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { processFileAttachments, type SlackFile } from "../../src/slack/file-handler.js";

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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/slack/file-handler.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the file handler**

Create `src/slack/file-handler.ts`:

```typescript
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"]);

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
  size: number;
}

export interface FileProcessingResult {
  /** Paths of successfully saved files */
  savedFiles: string[];
  /** Vision content blocks for images (base64) */
  imageContents: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }>;
  /** Text annotations like "[User uploaded: file.csv → /uploads/file.csv]" */
  textAnnotations: string[];
}

interface ProcessOptions {
  files: SlackFile[];
  sandboxPath: string;
  botToken: string;
}

/**
 * Download Slack file attachments, save to sandbox, and prepare vision content.
 */
export async function processFileAttachments(options: ProcessOptions): Promise<FileProcessingResult> {
  const { files, sandboxPath, botToken } = options;
  const result: FileProcessingResult = {
    savedFiles: [],
    imageContents: [],
    textAnnotations: [],
  };

  if (!files || files.length === 0) return result;

  const uploadsDir = join(sandboxPath, "uploads");
  await mkdir(uploadsDir, { recursive: true });

  for (const file of files) {
    try {
      // Download file from Slack
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        console.error(`[FileHandler] Failed to download ${file.name}: HTTP ${response.status}`);
        result.textAnnotations.push(`[User uploaded: ${file.name} — failed to download]`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const savePath = join(uploadsDir, file.name);
      await writeFile(savePath, buffer);
      result.savedFiles.push(savePath);

      // For images, also create a vision content block
      const isImage = IMAGE_MIMES.has(file.mimetype);
      if (isImage) {
        result.imageContents.push({
          type: "image",
          source: {
            type: "base64",
            media_type: file.mimetype,
            data: buffer.toString("base64"),
          },
        });
        result.textAnnotations.push(
          `[User uploaded: ${file.name} → /uploads/${file.name} (attached as image)]`
        );
      } else {
        result.textAnnotations.push(
          `[User uploaded: ${file.name} → /uploads/${file.name}]`
        );
      }
    } catch (error) {
      console.error(`[FileHandler] Error processing ${file.name}:`, error);
      result.textAnnotations.push(`[User uploaded: ${file.name} — failed to download]`);
    }
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack/file-handler.test.ts`
Expected: PASS (the `writeFile` call will need mocking or you can use a temp dir — adapt as needed)

**Step 5: Commit**

```bash
git add src/slack/file-handler.ts tests/slack/file-handler.test.ts
git commit -m "feat: add file attachment handler for Slack uploads"
```

---

### Task 5: Wire File Handler into Gateway and Worker

**Files:**
- Modify: `src/slack/gateway.ts`
- Modify: `src/queue/worker.ts`
- Modify: `src/queue/types.ts`

**Step 1: Add file metadata to job data types**

In `src/queue/types.ts`, add file info to both job data types:

```typescript
/** Slack file attachment metadata */
export interface SlackFileAttachment {
  id: string;
  name: string;
  mimetype: string;
  url_private_download: string;
  size: number;
}

export interface StartSessionJobData extends BaseJobData {
  type: "start_session";
  channelId: string;
  userId: string;
  message: string;
  threadTs?: string;
  files?: SlackFileAttachment[];  // ← ADD
}

export interface ContinueSessionJobData extends BaseJobData {
  type: "continue_session";
  sessionId: string;
  message: string;
  files?: SlackFileAttachment[];  // ← ADD
}
```

**Step 2: Extract files from Slack events in gateway**

In `src/slack/gateway.ts`, update `MentionPayload` and `ThreadMessagePayload` to include files:

```typescript
export interface MentionPayload {
  user: string;
  text: string;
  channel: string;
  ts: string;
  say: SayFn;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private_download: string;
    size: number;
  }>;
}

export interface ThreadMessagePayload {
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts: string;
  say: SayFn;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private_download: string;
    size: number;
  }>;
}
```

Update the event handlers in `onMention` and `onThreadMessage` to extract `msg.files`:

```typescript
// In onMention's app_mention handler:
files: (e.files as any[])?.map((f: any) => ({
  id: f.id, name: f.name, mimetype: f.mimetype,
  url_private_download: f.url_private_download, size: f.size,
})),

// Same in onThreadMessage handler
```

**Step 3: Process files in worker before SDK call**

In `src/queue/worker.ts`, import `processFileAttachments` and call it before `runSession`/`continueSession`:

```typescript
import { processFileAttachments } from "../slack/file-handler.js";
import { env } from "../config/env.js";

// In processStartSession, after creating session:
let userMessage = message;
if (job.data.files && job.data.files.length > 0) {
  const fileResult = await processFileAttachments({
    files: job.data.files,
    sandboxPath: session.sandboxPath,
    botToken: env.SLACK_BOT_TOKEN,
  });
  // Prepend file annotations to the user message
  if (fileResult.textAnnotations.length > 0) {
    userMessage = fileResult.textAnnotations.join("\n") + "\n\n" + message;
  }
  // TODO: Pass imageContents as vision content blocks (Task 6)
}

const result = await runSession(session, userMessage, ...);
```

**Step 4: Pass files from app.ts queue calls**

In `src/app.ts`, wherever `start_session` or `continue_session` jobs are queued, pass through `payload.files`:

```typescript
// In the onMention handler:
await queue.add("start_session", {
  type: "start_session",
  channelId: payload.channel,
  userId: payload.user,
  message: payload.text,
  threadTs: payload.ts,
  files: payload.files,  // ← ADD
  timestamp: Date.now(),
});
```

**Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/slack/gateway.ts src/queue/worker.ts src/queue/types.ts src/app.ts
git commit -m "feat: wire file attachment handler into gateway and worker pipeline"
```

---

### Task 6: Pass Image Vision Content to SDK

**Files:**
- Modify: `src/agent/sdk-runtime.ts`
- Modify: `src/queue/worker.ts`

This task extends the SDK call to pass image content blocks as multimodal input so Claude can "see" uploaded images.

**Step 1: Check SDK prompt format for vision**

The SDK `query()` function accepts a `prompt` parameter. For multimodal input, check if it supports content blocks or if images need to be passed differently (e.g., via the message format). The SDK may accept an array of content blocks as the prompt.

Look at the SDK's `Options` type for `prompt` — if it accepts `string | ContentBlock[]`, pass image blocks directly. If it only accepts `string`, encode image references in the text and rely on the sandbox file path.

**Step 2: Update worker to pass vision data**

If SDK supports multimodal prompt:

```typescript
// In worker, after processFileAttachments:
const promptBlocks = [];
if (fileResult.imageContents.length > 0) {
  promptBlocks.push(...fileResult.imageContents);
}
promptBlocks.push({ type: "text", text: userMessage });

// Pass promptBlocks instead of string to runSession
```

If SDK only supports string prompt, the text annotations from Task 5 are sufficient — the agent can use the Read tool to access files at the sandbox paths.

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Integration test**

1. In Slack, post a message with an image attachment to a thread with the bot
2. Verify the bot can "see" the image and describe it
3. Post a CSV file and verify the bot can read it from the sandbox

**Step 5: Commit**

```bash
git add src/agent/sdk-runtime.ts src/queue/worker.ts
git commit -m "feat: pass image attachments as vision content to Claude"
```

---

### Task 7: Integration Test — Full Flow

**Manual verification steps:**

1. **Upload tool test**: Ask the bot "generate a sample CSV with 5 rows of user data and upload it to this thread"
   - Expected: Bot calls `slack_upload_file`, file appears as native Slack attachment in thread

2. **Image input test**: Upload a screenshot to a thread with the bot and ask "what's in this image?"
   - Expected: Bot describes the image contents using vision

3. **Non-image file test**: Upload a CSV to a thread and ask "summarize this data"
   - Expected: Bot reads the file from sandbox using Read tool and summarizes

4. **Mixed test**: Upload an image + text and ask a question about both
   - Expected: Bot handles both the vision input and text correctly
