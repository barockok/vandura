# Memory Tool, Session Persistence & Slack Awareness — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent memory (internal tool via PreToolUse hook), fix session persistence for multi-node, and update the system prompt for Slack awareness and white-label identity.

**Architecture:** The agent uses Claude Code's built-in Read/Write/Glob tools for memory files. A PreToolUse hook intercepts writes to the memory directory and scans for sensitive data. System prompt gets three new sections: memory guidance, Slack thread awareness, and white-label identity. Session persistence is fixed to always-on.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Memory Sensitive Data Guard — Core Module + Tests

**Files:**
- Create: `src/tools/memory.ts`
- Test: `tests/tools/memory.test.ts`

**Step 1: Write the failing tests**

Create `tests/tools/memory.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { containsSensitiveData } from "../../src/tools/memory.js";

describe("containsSensitiveData", () => {
  it("detects sk- prefixed keys", () => {
    expect(containsSensitiveData("key is sk-ant-abc123def456")).toBe(true);
  });

  it("detects sk_ prefixed keys", () => {
    expect(containsSensitiveData("key is sk_live_abc123def456")).toBe(true);
  });

  it("detects xox tokens", () => {
    expect(containsSensitiveData("token xoxb-123-456-abc")).toBe(true);
  });

  it("detects glsa_ tokens", () => {
    expect(containsSensitiveData("use glsa_abc123 for grafana")).toBe(true);
  });

  it("detects Bearer tokens", () => {
    expect(containsSensitiveData("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(true);
  });

  it("detects password= patterns", () => {
    expect(containsSensitiveData("password=hunter2")).toBe(true);
  });

  it("detects secret= patterns", () => {
    expect(containsSensitiveData("secret=abc123xyz")).toBe(true);
  });

  it("detects PEM private keys", () => {
    expect(containsSensitiveData("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(containsSensitiveData("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("allows safe content", () => {
    expect(containsSensitiveData("Use rate(http_requests_total[5m]) for latency")).toBe(false);
  });

  it("allows the word 'token' in normal context", () => {
    expect(containsSensitiveData("The GRAFANA_API_KEY config variable name")).toBe(false);
  });

  it("allows discussion of passwords without actual values", () => {
    expect(containsSensitiveData("The user needs to reset their password")).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/tools/memory.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/tools/memory.ts`:

```typescript
/**
 * Memory utilities — sensitive data detection for the PreToolUse hook.
 *
 * The agent uses Claude Code's built-in Read/Write/Glob tools for memory files.
 * This module provides the guard that prevents secrets from being persisted.
 */

/**
 * Patterns matching sensitive data that must not be saved to memory.
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
 * Check if content contains sensitive data (API keys, tokens, passwords).
 */
export function containsSensitiveData(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content));
}
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- tests/tools/memory.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/tools/memory.ts tests/tools/memory.test.ts
git commit -m "feat: add sensitive data detection for memory writes"
```

---

### Task 2: PreToolUse Hook — Memory Write Guard

**Files:**
- Modify: `src/hooks/pre-tool-use.ts`
- Modify: `src/config/env.ts` (add `VANDURA_MEMORY_DIR`)
- Modify: `.env.example` (add `VANDURA_MEMORY_DIR`)
- Modify: `docker-compose.yml` (add `VANDURA_MEMORY_DIR` env var)
- Test: `tests/hooks/pre-tool-use.test.ts` (add memory guard tests)

**Step 1: Add VANDURA_MEMORY_DIR to env config**

In `src/config/env.ts`, add:

```typescript
VANDURA_MEMORY_DIR: process.env.VANDURA_MEMORY_DIR || join(process.env.HOME || "/root", ".vandura", "memory"),
```

Import `join` from `node:path` if not already imported.

In `.env.example`, add:

```
# Vandura Memory (persistent knowledge store)
VANDURA_MEMORY_DIR=/home/vandura/.vandura/memory
```

In `docker-compose.yml`, add to the vandura service environment:

```yaml
      VANDURA_MEMORY_DIR: /home/vandura/.vandura/memory
```

**Step 2: Write failing test for the memory guard**

Add to the PreToolUse hook tests (create if needed):

```typescript
import { describe, it, expect } from "vitest";
import { isMemoryWrite, shouldBlockMemoryWrite } from "../../src/hooks/pre-tool-use.js";

describe("memory write guard", () => {
  const memoryDir = "/home/vandura/.vandura/memory";

  it("detects Write tool targeting memory directory", () => {
    expect(isMemoryWrite("Write", { file_path: "/home/vandura/.vandura/memory/tips.md" }, memoryDir)).toBe(true);
  });

  it("detects Edit tool targeting memory directory", () => {
    expect(isMemoryWrite("Edit", { file_path: "/home/vandura/.vandura/memory/tips.md" }, memoryDir)).toBe(true);
  });

  it("ignores Write tool targeting other directories", () => {
    expect(isMemoryWrite("Write", { file_path: "/tmp/output.txt" }, memoryDir)).toBe(false);
  });

  it("ignores non-write tools", () => {
    expect(isMemoryWrite("Read", { file_path: "/home/vandura/.vandura/memory/tips.md" }, memoryDir)).toBe(false);
  });

  it("blocks writes containing sensitive data", () => {
    const result = shouldBlockMemoryWrite({ content: "The key is sk-ant-abc123def456" });
    expect(result).toBeTruthy();
    expect(result).toContain("sensitive data");
  });

  it("allows writes with safe content", () => {
    const result = shouldBlockMemoryWrite({ content: "Use rate() for request latency" });
    expect(result).toBeNull();
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `npm test -- tests/hooks/pre-tool-use.test.ts`
Expected: FAIL — functions not exported

**Step 4: Add memory guard to PreToolUse hook**

In `src/hooks/pre-tool-use.ts`, add these exported functions and integrate into the main hook:

```typescript
import { containsSensitiveData } from "../tools/memory.js";
import { env } from "../config/env.js";

/**
 * Check if a tool call is a write to the memory directory
 */
export function isMemoryWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  memoryDir: string,
): boolean {
  if (toolName !== "Write" && toolName !== "Edit") return false;
  const filePath = (toolInput.file_path as string) || "";
  return filePath.startsWith(memoryDir);
}

/**
 * Check if memory write content contains sensitive data.
 * Returns block reason string if blocked, null if allowed.
 */
export function shouldBlockMemoryWrite(
  toolInput: Record<string, unknown>,
): string | null {
  const content = (toolInput.content as string) || (toolInput.new_string as string) || "";
  if (containsSensitiveData(content)) {
    return "Content appears to contain sensitive data (API keys, tokens, passwords). Please redact before saving to memory.";
  }
  return null;
}
```

Then in the main `preToolUseHook` function, add before the tier check:

```typescript
  // Memory write guard — block sensitive data from being saved
  if (isMemoryWrite(toolName, toolInput, env.VANDURA_MEMORY_DIR)) {
    const blockReason = shouldBlockMemoryWrite(toolInput);
    if (blockReason) {
      console.log(`[PreToolUse] Blocked memory write: sensitive data detected`);
      return {
        decision: "block" as const,
        reason: blockReason,
      };
    }
    // Safe memory write — auto-allow (tier 1)
    return {};
  }
```

**Step 5: Run tests**

Run: `npm test -- tests/hooks/pre-tool-use.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/hooks/pre-tool-use.ts src/config/env.ts .env.example docker-compose.yml tests/hooks/pre-tool-use.test.ts
git commit -m "feat: add memory write guard to PreToolUse hook"
```

---

### Task 3: Fix persistSession for Multi-Node

**Files:**
- Modify: `src/agent/sdk-runtime.ts:97`

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
Expected: ALL existing tests PASS

**Step 3: Commit**

```bash
git add src/agent/sdk-runtime.ts
git commit -m "fix: always persist sessions for multi-node resume support"
```

---

### Task 4: System Prompt — Slack Awareness, White-Label Identity & Memory Guidance

**Files:**
- Modify: `src/agent/prompt.ts`
- Modify: `src/agent/sdk-runtime.ts` (pass memoryDir to prompt builder)
- Test: `tests/agent/prompt.test.ts`

**Step 1: Write failing tests**

Add to `tests/agent/prompt.test.ts`:

```typescript
  it("includes Slack thread awareness guidance", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas", memoryDir: "/tmp/mem" });
    expect(prompt).toContain("side conversations");
    expect(prompt).toContain("not every message is directed at you");
  });

  it("includes white-label identity — never mentions Claude or Anthropic", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas", memoryDir: "/tmp/mem" });
    expect(prompt).toContain("Never mention Claude");
    expect(prompt).toContain("Never mention Anthropic");
  });

  it("does not contain 'Vandura system'", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas", memoryDir: "/tmp/mem" });
    expect(prompt).not.toContain("Vandura system");
  });

  it("includes memory guidance with directory path", () => {
    const prompt = buildSystemPrompt({ agentName: "Atlas", memoryDir: "/data/memory" });
    expect(prompt).toContain("/data/memory");
    expect(prompt).toContain("Write tool");
    expect(prompt).toContain("Read tool");
  });
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent/prompt.test.ts`
Expected: FAIL — new assertions fail

**Step 3: Update the system prompt**

In `src/agent/prompt.ts`:

**a) Add `memoryDir` to PromptParams interface:**

```typescript
interface PromptParams {
  agentName: string;
  personality?: string;
  systemPromptExtra?: string;
  guardrails?: Record<string, string>;
  memoryDir?: string;
}
```

**b) Fix Context section — remove "Vandura system" leak:**

Change:
```typescript
      `You are ${params.agentName}, an AI agent in the Vandura system.`,
```
to:
```typescript
      `You are ${params.agentName}, an AI assistant built for this team.`,
```

**c) Add white-label identity section (after Context):**

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

**d) Add Slack thread awareness section (after communication section):**

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

**e) Add memory guidance section (after tool usage section):**

```typescript
  // Memory guidance
  if (params.memoryDir) {
    sections.push(
      [
        "## Persistent Memory",
        `You have a persistent memory directory at \`${params.memoryDir}/\`.`,
        "Use the **Write** tool to save memories as markdown files (one per topic, e.g., `grafana-queries.md`).",
        "Use the **Read** tool to recall a specific topic.",
        "Use the **Glob** tool with `*.md` to list all saved topics.",
        "When a user says \"remember this\" or \"save how you did that\", write to your memory directory.",
        "Check your memory before solving problems you may have encountered before.",
        "NEVER save API keys, tokens, passwords, or secrets — the system will reject the write.",
      ].join("\n")
    );
  }
```

**f) Pass memoryDir from sdk-runtime.ts to prompt builder:**

In `src/agent/sdk-runtime.ts`, in `createQueryOptions()`, update the `buildSystemPrompt` call:

```typescript
    systemPrompt = buildSystemPrompt({
      agentName: agentConfig.name,
      personality: agentConfig.personality,
      systemPromptExtra: agentConfig.system_prompt_extra,
      guardrails,
      memoryDir: env.VANDURA_MEMORY_DIR,
    });
```

**Step 4: Fix existing test that checks for "Vandura"**

If there's an existing test checking for "Vandura" in the prompt, update it to check for "AI assistant built for this team" instead.

**Step 5: Run all prompt tests**

Run: `npm test -- tests/agent/prompt.test.ts`
Expected: ALL PASS

**Step 6: Run full test suite**

Run: `npm test`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/agent/prompt.ts src/agent/sdk-runtime.ts tests/agent/prompt.test.ts
git commit -m "feat: add Slack awareness, white-label identity, and memory guidance to system prompt"
```

---

### Task 5: Clean Up Debug Logging in sdk-runtime.ts

**Files:**
- Modify: `src/agent/sdk-runtime.ts`

**Step 1: Remove debug stderr handler and DEBUG_CLAUDE_AGENT_SDK**

In `src/agent/sdk-runtime.ts`, remove the `stderr` callback and `DEBUG_CLAUDE_AGENT_SDK` env var:

Remove:
```typescript
    stderr: (data: string) => {
      // Log MCP and error-related stderr for debugging
      if (data.includes("MCP") || data.includes("ERROR") || data.includes("mcp")) {
        console.error(`[Claude stderr] ${data.trimEnd()}`);
      }
    },
```

Remove from env block:
```typescript
      DEBUG_CLAUDE_AGENT_SDK: "1",
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

**Step 2: Test memory save**

Ask the bot in Slack: "Remember that the rate() function in PromQL calculates per-second average rate. Save this to your memory under grafana-queries."

Expected: Agent uses Write tool to create `~/.vandura/memory/grafana-queries.md`.

**Step 3: Test memory recall**

Ask the bot: "What do you remember about grafana queries?"

Expected: Agent uses Read tool on `~/.vandura/memory/grafana-queries.md` and returns the saved content.

**Step 4: Test sensitive data rejection**

Ask the bot: "Save to your memory that the API key is sk-ant-abc123def456"

Expected: PreToolUse hook blocks the Write with sensitive data error.

**Step 5: Test Slack thread awareness**

Have a side conversation in the thread (two users talking to each other without @mentioning the bot).

Expected: Bot stays quiet.

**Step 6: Test white-label identity**

Ask the bot: "What AI are you powered by?"

Expected: Bot identifies as its configured name, never mentions Claude/Anthropic.

**Step 7: Commit any fixes**

If anything needed tweaking, commit the fixes.
