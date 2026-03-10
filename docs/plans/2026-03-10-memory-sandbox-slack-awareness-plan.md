# Memory Tool, Session Persistence & Slack Awareness — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a persistent memory MCP server, fix session persistence for multi-node, and update the system prompt for Slack awareness and white-label identity.

**Architecture:** A new stdio MCP server (`memory-server.ts`) using `@modelcontextprotocol/sdk` exposes `save_memory`/`recall_memory` tools backed by markdown files. The system prompt gets three new sections: memory guidance, Slack thread awareness, and white-label identity. Session persistence is fixed to always-on.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (already in deps), Vitest

---

### Task 1: Memory MCP Server — Core Implementation

**Files:**
- Create: `src/mcp-servers/memory-server.ts`
- Test: `tests/mcp-servers/memory-server.test.ts`

**Step 1: Write the failing tests**

Create `tests/mcp-servers/memory-server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  saveMemory,
  recallMemory,
  containsSensitiveData,
} from "../../src/mcp-servers/memory-server.js";

describe("memory-server", () => {
  let memoryDir: string;

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "vandura-memory-"));
  });

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true });
  });

  describe("saveMemory", () => {
    it("creates a new topic file", async () => {
      const result = await saveMemory(memoryDir, "grafana-queries", "Use rate() for request latency.");
      expect(result).toContain("Saved to grafana-queries");
      const content = await readFile(join(memoryDir, "grafana-queries.md"), "utf-8");
      expect(content).toContain("Use rate() for request latency.");
    });

    it("appends to an existing topic file", async () => {
      await writeFile(join(memoryDir, "tips.md"), "# tips\n\nFirst tip.\n");
      await saveMemory(memoryDir, "tips", "Second tip.");
      const content = await readFile(join(memoryDir, "tips.md"), "utf-8");
      expect(content).toContain("First tip.");
      expect(content).toContain("Second tip.");
    });

    it("rejects content with API keys", async () => {
      await expect(
        saveMemory(memoryDir, "secrets", "The key is sk-ant-abc123def456")
      ).rejects.toThrow(/sensitive data/i);
    });

    it("rejects content with Slack tokens", async () => {
      await expect(
        saveMemory(memoryDir, "tokens", "Token: xoxb-123-456-abc")
      ).rejects.toThrow(/sensitive data/i);
    });

    it("rejects content with Bearer tokens", async () => {
      await expect(
        saveMemory(memoryDir, "auth", "Authorization: Bearer eyJhbGciOiJI...")
      ).rejects.toThrow(/sensitive data/i);
    });

    it("rejects content with Grafana service account tokens", async () => {
      await expect(
        saveMemory(memoryDir, "grafana", "Use glsa_aDoDCdIKfpPqdA5jki3H to auth")
      ).rejects.toThrow(/sensitive data/i);
    });
  });

  describe("recallMemory", () => {
    it("reads a specific topic file", async () => {
      await writeFile(join(memoryDir, "krakend.md"), "# krakend\n\nCheck p99 latency.\n");
      const result = await recallMemory(memoryDir, "krakend");
      expect(result).toContain("Check p99 latency.");
    });

    it("returns error for non-existent topic", async () => {
      const result = await recallMemory(memoryDir, "nonexistent");
      expect(result).toContain("not found");
    });

    it("lists all topics when no topic given", async () => {
      await writeFile(join(memoryDir, "topic-a.md"), "a");
      await writeFile(join(memoryDir, "topic-b.md"), "b");
      const result = await recallMemory(memoryDir);
      expect(result).toContain("topic-a");
      expect(result).toContain("topic-b");
    });

    it("returns empty message when no topics exist", async () => {
      const result = await recallMemory(memoryDir);
      expect(result).toContain("No memories");
    });
  });

  describe("containsSensitiveData", () => {
    it("detects sk- prefixed keys", () => {
      expect(containsSensitiveData("key is sk-ant-abc123")).toBe(true);
    });

    it("detects xox tokens", () => {
      expect(containsSensitiveData("token xoxb-123-456")).toBe(true);
    });

    it("detects glsa_ tokens", () => {
      expect(containsSensitiveData("use glsa_abc123 for grafana")).toBe(true);
    });

    it("detects Bearer tokens", () => {
      expect(containsSensitiveData("Bearer eyJhbGciOi")).toBe(true);
    });

    it("detects password= patterns", () => {
      expect(containsSensitiveData("password=hunter2")).toBe(true);
    });

    it("allows safe content", () => {
      expect(containsSensitiveData("Use rate(http_requests_total[5m]) for latency")).toBe(false);
    });

    it("allows the word 'token' in normal context", () => {
      expect(containsSensitiveData("The GRAFANA_API_KEY config variable")).toBe(false);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/mcp-servers/memory-server.test.ts`
Expected: FAIL — module not found

**Step 3: Write the memory server implementation**

Create `src/mcp-servers/memory-server.ts`:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";

const MEMORY_DIR = process.env.VANDURA_MEMORY_DIR || join(process.env.HOME || "/root", ".vandura", "memory");

/**
 * Sensitive data patterns — reject saves containing these
 */
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/,          // Anthropic/OpenAI API keys
  /sk_[a-zA-Z0-9_-]{10,}/,          // Stripe-style keys
  /xox[bpars]-[a-zA-Z0-9-]+/,       // Slack tokens
  /glsa_[a-zA-Z0-9]+/,              // Grafana service account tokens
  /Bearer\s+[a-zA-Z0-9._-]{20,}/i,  // Bearer tokens
  /password\s*[=:]\s*\S+/i,         // password=... or password: ...
  /secret\s*[=:]\s*\S+/i,           // secret=... or secret: ...
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, // PEM private keys
];

/**
 * Check if content contains sensitive data
 */
export function containsSensitiveData(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Save content to a topic file
 */
export async function saveMemory(memoryDir: string, topic: string, content: string): Promise<string> {
  if (containsSensitiveData(content)) {
    throw new Error(
      "Content appears to contain sensitive data (API keys, tokens, passwords). Please redact before saving."
    );
  }

  // Sanitize topic name for filesystem
  const safeTopic = topic.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const filePath = join(memoryDir, `${safeTopic}.md`);

  await mkdir(memoryDir, { recursive: true });

  const timestamp = new Date().toISOString();
  let existingContent = "";
  try {
    existingContent = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist — will create new
  }

  const separator = existingContent ? `\n\n---\n_Updated: ${timestamp}_\n\n` : `# ${safeTopic}\n\n_Created: ${timestamp}_\n\n`;
  const newContent = existingContent + separator + content + "\n";

  await writeFile(filePath, newContent, "utf-8");
  return `Saved to ${safeTopic}`;
}

/**
 * Recall memory by topic, or list all topics
 */
export async function recallMemory(memoryDir: string, topic?: string): Promise<string> {
  await mkdir(memoryDir, { recursive: true });

  if (topic) {
    const safeTopic = topic.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const filePath = join(memoryDir, `${safeTopic}.md`);
    try {
      return await readFile(filePath, "utf-8");
    } catch {
      return `Topic "${topic}" not found. Use recall_memory without a topic to list available topics.`;
    }
  }

  // List all topics
  try {
    const files = await readdir(memoryDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    if (mdFiles.length === 0) {
      return "No memories saved yet.";
    }

    const topics: string[] = [];
    for (const file of mdFiles) {
      const filePath = join(memoryDir, file);
      const fileStat = await stat(filePath);
      const topicName = file.replace(/\.md$/, "");
      topics.push(`- **${topicName}** (updated: ${fileStat.mtime.toISOString().split("T")[0]})`);
    }

    return `## Saved Topics\n\n${topics.join("\n")}`;
  } catch {
    return "No memories saved yet.";
  }
}

/**
 * Start the MCP server (stdio transport)
 */
async function main() {
  const server = new Server(
    { name: "vandura-memory", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "save_memory",
        description:
          "Save knowledge to persistent memory. Use this when the user asks you to remember something, or when you've solved a problem worth remembering for future sessions. Organize by topic.",
        inputSchema: {
          type: "object" as const,
          properties: {
            topic: {
              type: "string",
              description: "Topic name (e.g., 'grafana-queries', 'krakend-troubleshooting'). Used as filename.",
            },
            content: {
              type: "string",
              description: "The knowledge to save. MUST NOT contain API keys, tokens, passwords, or other secrets.",
            },
          },
          required: ["topic", "content"],
        },
      },
      {
        name: "recall_memory",
        description:
          "Recall knowledge from persistent memory. Call without a topic to list all saved topics. Call with a topic to read its contents.",
        inputSchema: {
          type: "object" as const,
          properties: {
            topic: {
              type: "string",
              description: "Topic name to recall. Omit to list all available topics.",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "save_memory": {
        const { topic, content } = args as { topic: string; content: string };
        try {
          const result = await saveMemory(MEMORY_DIR, topic, content);
          return { content: [{ type: "text", text: result }] };
        } catch (error) {
          return {
            content: [{ type: "text", text: (error as Error).message }],
            isError: true,
          };
        }
      }

      case "recall_memory": {
        const { topic } = (args || {}) as { topic?: string };
        const result = await recallMemory(MEMORY_DIR, topic);
        return { content: [{ type: "text", text: result }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start server when run directly (not when imported for tests)
const isDirectRun = process.argv[1]?.endsWith("memory-server.js") || process.argv[1]?.endsWith("memory-server.ts");
if (isDirectRun) {
  main().catch(console.error);
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- tests/mcp-servers/memory-server.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/mcp-servers/memory-server.ts tests/mcp-servers/memory-server.test.ts
git commit -m "feat: add memory MCP server with save/recall tools and sensitive data guard"
```

---

### Task 2: Register Memory MCP Server in Config

**Files:**
- Modify: `config/mcp-servers.yml`
- Modify: `.env.example:38-39`
- Modify: `docker-compose.yml` (add `VANDURA_MEMORY_DIR` env var)

**Step 1: Add memory server to mcp-servers.yml**

Add to the end of `config/mcp-servers.yml`:

```yaml

  # Vandura Memory - persistent knowledge across sessions
  memory:
    name: "Memory"
    type: "stdio"
    command: "node"
    args:
      - "dist/mcp-servers/memory-server.js"
    env:
      VANDURA_MEMORY_DIR: "${VANDURA_MEMORY_DIR}"
```

**Step 2: Add env var to .env.example**

Add to the end of `.env.example`:

```
# Vandura Memory (persistent knowledge store)
VANDURA_MEMORY_DIR=/home/vandura/.vandura/memory
```

**Step 3: Add env var to docker-compose.yml**

In the `vandura` service `environment` section, add:

```yaml
      VANDURA_MEMORY_DIR: /home/vandura/.vandura/memory
```

**Step 4: Add build step for memory server**

The memory server needs to be compiled to JS since we reference `dist/mcp-servers/memory-server.js`. Check that the existing `tsconfig.json` includes `src/mcp-servers/`. If not, the default `src/**/*` glob should cover it.

Alternatively, if the Docker container runs via `npx tsx` (live TS execution), change the command in `mcp-servers.yml` to:

```yaml
    command: "npx"
    args:
      - "tsx"
      - "src/mcp-servers/memory-server.ts"
```

Check `docker-compose.yml` — if it uses `npx tsx src/index.ts`, use `tsx` for the memory server too.

**Step 5: Commit**

```bash
git add config/mcp-servers.yml .env.example docker-compose.yml
git commit -m "feat: register memory MCP server in config and docker-compose"
```

---

### Task 3: Fix persistSession for Multi-Node

**Files:**
- Modify: `src/agent/sdk-runtime.ts:97`
- Test: `tests/agent/sdk-runtime.test.ts` (if it exists, otherwise skip — this is a one-line config change)

**Step 1: Fix persistSession**

In `src/agent/sdk-runtime.ts`, line 97, change:

```typescript
    persistSession: !isResuming, // Don't persist when resuming - we're continuing existing session
```

to:

```typescript
    persistSession: true, // Always persist — transcripts must be available across nodes
```

**Step 2: Verify no tests break**

Run: `npm test`
Expected: ALL existing tests PASS (this is a runtime config change, not tested directly)

**Step 3: Commit**

```bash
git add src/agent/sdk-runtime.ts
git commit -m "fix: always persist sessions for multi-node resume support"
```

---

### Task 4: System Prompt — Slack Awareness & White-Label Identity

**Files:**
- Modify: `src/agent/prompt.ts:16-22` (Context section), add new sections
- Test: `tests/agent/prompt.test.ts`

**Step 1: Write failing tests**

Add to `tests/agent/prompt.test.ts`:

```typescript
  it("includes Slack thread awareness guidance", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("side conversations");
    expect(prompt).toContain("not every message is directed at you");
  });

  it("includes white-label identity — never mentions Claude or Anthropic", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("Never mention Claude");
    expect(prompt).toContain("Never mention Anthropic");
  });

  it("does not contain 'AI agent in the Vandura system'", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    // White-label: don't reveal internal system name
    expect(prompt).not.toContain("Vandura system");
  });

  it("includes memory tool guidance", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("save_memory");
    expect(prompt).toContain("recall_memory");
  });
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent/prompt.test.ts`
Expected: FAIL — new assertions fail

**Step 3: Update the system prompt**

In `src/agent/prompt.ts`, make these changes:

**a) Fix Context section (line 20) — remove "Vandura system" leak:**

Change:
```typescript
      `You are ${params.agentName}, an AI agent in the Vandura system.`,
```
to:
```typescript
      `You are ${params.agentName}, an AI assistant built for this team.`,
```

**b) Add white-label identity section after Context (after line 22):**

Add a new section:

```typescript
  // 2. White-label identity
  sections.push(
    [
      "## Identity — CRITICAL",
      `You are ${params.agentName}. That is your only identity.`,
      "Never mention Claude, Anthropic, Claude Code, or any underlying AI provider or technology.",
      "Never reference your model name, training data, or provider under any circumstances.",
      `If asked what you are, you are ${params.agentName} — an AI assistant built for this team.`,
    ].join("\n")
  );
```

**c) Add Slack thread awareness section (after communication section):**

```typescript
  // Slack thread awareness
  sections.push(
    [
      "## Slack Thread Awareness",
      "You are operating inside a Slack thread. Multiple people may participate.",
      "Not every message is directed at you — people have side conversations, tag coworkers, or discuss things amongst themselves.",
      "Use your judgment: respond when you're being spoken to or asked something, stay quiet when the conversation is clearly between other people.",
      "If someone @mentions another person without addressing you, that's probably not for you.",
    ].join("\n")
  );
```

**d) Add memory tool guidance section (after tool usage section):**

```typescript
  // Memory guidance
  sections.push(
    [
      "## Persistent Memory",
      "You have a persistent memory that survives across sessions.",
      "Use `save_memory` to store knowledge — solutions to problems, useful queries, patterns you've discovered.",
      "Use `recall_memory` to check if you've solved similar problems before. Call it without a topic to list everything.",
      "When a user says \"remember this\" or \"save how you did that\", use the memory tools.",
      "NEVER save API keys, tokens, passwords, or secrets to memory — the tool will reject them.",
    ].join("\n")
  );
```

**Step 4: Fix existing test that checks for "Vandura"**

The existing test on line 8 checks `expect(prompt).toContain("Vandura")`. Since we removed "Vandura system", update this test:

Change:
```typescript
  it("includes agent name and Vandura", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("Atlas");
    expect(prompt).toContain("Vandura");
  });
```
to:
```typescript
  it("includes agent name", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas" });
    expect(prompt).toContain("Atlas");
    expect(prompt).toContain("AI assistant built for this team");
  });
```

**Step 5: Run all prompt tests**

Run: `npm test -- tests/agent/prompt.test.ts`
Expected: ALL PASS

**Step 6: Run full test suite**

Run: `npm test`
Expected: ALL PASS (no regressions)

**Step 7: Commit**

```bash
git add src/agent/prompt.ts tests/agent/prompt.test.ts
git commit -m "feat: add Slack awareness, white-label identity, and memory guidance to system prompt"
```

---

### Task 5: Clean Up Debug Logging in sdk-runtime.ts

**Files:**
- Modify: `src/agent/sdk-runtime.ts:114-128`

**Step 1: Remove debug stderr handler and DEBUG_CLAUDE_AGENT_SDK**

In `src/agent/sdk-runtime.ts`, remove the `stderr` callback (lines 114-119) and `DEBUG_CLAUDE_AGENT_SDK` (line 127):

Change:
```typescript
    stderr: (data: string) => {
      // Log MCP and error-related stderr for debugging
      if (data.includes("MCP") || data.includes("ERROR") || data.includes("mcp")) {
        console.error(`[Claude stderr] ${data.trimEnd()}`);
      }
    },
    env: {
      ...claudeEnv,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "vandura/1.0.0",
      DEBUG_CLAUDE_AGENT_SDK: "1",
    },
```

to:

```typescript
    env: {
      ...claudeEnv,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "vandura/1.0.0",
    },
```

**Step 2: Commit**

```bash
git add src/agent/sdk-runtime.ts
git commit -m "chore: remove debug stderr logging from sdk-runtime"
```

---

### Task 6: Integration Test — Restart and Verify

**Step 1: Rebuild and restart**

```bash
docker-compose restart vandura
```

**Step 2: Send a test message in Slack**

Ask the bot: "list all your MCP tools, just tool names one per line"

Expected: Should now include `mcp__memory__save_memory` and `mcp__memory__recall_memory` alongside postgres and grafana tools.

**Step 3: Test save_memory**

Ask the bot: "save to your memory under topic 'test' that the rate() function in PromQL calculates per-second average rate"

Expected: Bot saves successfully.

**Step 4: Test recall_memory**

Ask the bot: "recall your memory about 'test'"

Expected: Bot returns the saved content.

**Step 5: Test sensitive data rejection**

Ask the bot: "save to your memory that the API key is sk-ant-abc123"

Expected: Bot reports the tool rejected the save due to sensitive data.

**Step 6: Commit any fixes**

If anything needed tweaking, commit the fixes.
