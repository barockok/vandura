# Vandura Phase 2: Tool Execution, Approval Flows & Deployment

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform Vandura from a basic chat bot into a tool-executing agent with tiered approval workflows, Slack-based approval UX, checker nomination, task lifecycle management, large-result uploads, health monitoring, and Kubernetes deployment.

**Architecture:** The agent runtime switches from plain text chat to the Anthropic tool-use API. A tool executor middleware intercepts each tool call, classifies it through the approval engine, posts approval requests in Slack threads (tier 2 → initiator, tier 3 → checker), waits for thread replies to approve/deny, then executes via the MCP server. Large results auto-upload to S3/MinIO with signed URLs. The whole system is packaged into K8s manifests.

**Tech Stack:** TypeScript, Anthropic Messages API (tool use), `pg` (as MCP-like Postgres tool), Slack Bolt SDK, Vitest, Docker, Kubernetes

---

## Context: Current Codebase

- `src/agent/runtime.ts` — `AgentRuntime.chat()` sends plain text, no tools. Uses `@anthropic-ai/sdk` directly.
- `src/approval/engine.ts` — `ApprovalEngine.classify()` resolves static tiers. `requestApproval()` / `resolve()` persist to Postgres. Not wired to agent.
- `src/app.ts` — Wires Slack gateway → thread manager → agent runtime. No tool calls. No approval flow.
- `src/slack/gateway.ts` — `onMention`, `onThreadMessage`, `onMemberJoined`. Has `setBotUserId()`.
- `src/threads/manager.ts` — `createTask`, `findByThread`, `setChecker`, `addMessage`, `getMessages`, `closeTask`.
- `src/storage/s3.ts` — `StorageService` with `upload()` / `download()`. Works with MinIO.
- `src/config/types.ts` — `ToolPolicy` has `tier: 1|2|3|"dynamic"`, `guardrails`, `checker`.
- DB schema: `tasks`, `messages`, `approvals`, `audit_log`, `agents`, `users` tables all exist.
- Tests: unit tests in `tests/`, E2E Slack test in `tests/e2e/slack-flow.test.ts`.

---

### Task 1: Postgres Tool — Direct SQL Executor

Build a simple Postgres query tool that the agent can call. Not a full MCP server — just a typed function that accepts SQL, executes it, and returns results. This keeps things simple for v1.

**Files:**
- Create: `src/tools/postgres.ts`
- Create: `src/tools/types.ts`
- Test: `tests/tools/postgres.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/tools/postgres.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createPool, type Pool } from "../../src/db/connection.js";
import { PostgresTool } from "../../src/tools/postgres.js";

describe("PostgresTool", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let tool: PostgresTool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(60_000)
      .start();
    pool = createPool(container.getConnectionUri());
    await pool.query("CREATE TABLE test_users (id SERIAL PRIMARY KEY, name TEXT, age INT)");
    await pool.query("INSERT INTO test_users (name, age) VALUES ('Alice', 30), ('Bob', 25), ('Charlie', 35)");
    tool = new PostgresTool(pool);
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("executes a SELECT query and returns rows", async () => {
    const result = await tool.execute({ sql: "SELECT name, age FROM test_users ORDER BY name" });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toEqual({ name: "Alice", age: 30 });
    expect(result.rowCount).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it("returns column metadata", async () => {
    const result = await tool.execute({ sql: "SELECT name FROM test_users LIMIT 1" });
    expect(result.columns).toEqual(["name"]);
  });

  it("handles query errors gracefully", async () => {
    const result = await tool.execute({ sql: "SELECT * FROM nonexistent_table" });
    expect(result.error).toBeDefined();
    expect(result.rows).toEqual([]);
  });

  it("runs EXPLAIN and returns the plan", async () => {
    const result = await tool.explain("SELECT * FROM test_users WHERE age > 25");
    expect(result.plan).toBeDefined();
    expect(result.plan.length).toBeGreaterThan(0);
    expect(result.estimatedRows).toBeGreaterThanOrEqual(0);
  });

  it("returns the tool definition for Anthropic API", () => {
    const def = tool.definition();
    expect(def.name).toBe("db_query");
    expect(def.input_schema).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/postgres.test.ts`
Expected: FAIL — module not found

**Step 3: Write tool types**

```typescript
// src/tools/types.ts
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}
```

**Step 4: Write the Postgres tool implementation**

```typescript
// src/tools/postgres.ts
import type { Pool } from "../db/connection.js";
import type { ToolDefinition } from "./types.js";

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowCount: number;
  error?: string;
}

export interface ExplainResult {
  plan: string;
  estimatedRows: number;
}

export class PostgresTool {
  constructor(private pool: Pool) {}

  async execute(input: { sql: string }): Promise<QueryResult> {
    try {
      const result = await this.pool.query(input.sql);
      const columns = result.fields?.map((f: { name: string }) => f.name) ?? [];
      return {
        rows: result.rows ?? [],
        columns,
        rowCount: result.rowCount ?? 0,
      };
    } catch (err) {
      return {
        rows: [],
        columns: [],
        rowCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async explain(sql: string): Promise<ExplainResult> {
    const result = await this.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    const planJson = result.rows[0]?.["QUERY PLAN"] ?? [];
    const plan = JSON.stringify(planJson, null, 2);
    const estimatedRows = planJson[0]?.Plan?.["Plan Rows"] ?? 0;
    return { plan, estimatedRows };
  }

  definition(): ToolDefinition {
    return {
      name: "db_query",
      description: "Execute a read-only SQL query against the Postgres database. Use this for SELECT queries. For write operations, use db_write.",
      input_schema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "The SQL query to execute. Must be a valid PostgreSQL query.",
          },
        },
        required: ["sql"],
      },
    };
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/tools/postgres.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/tools/ tests/tools/
git commit -m "feat: add PostgresTool for SQL query execution"
```

---

### Task 2: Agent Runtime — Tool Use Loop

Rewrite `AgentRuntime.chat()` to use the Anthropic tool-use API. When Claude responds with a `tool_use` block, the runtime calls a tool executor callback, feeds the result back, and loops until Claude produces a final text response.

**Files:**
- Modify: `src/agent/runtime.ts`
- Modify: `tests/agent/runtime.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/agent/runtime.test.ts — replace the entire file
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentRuntime } from "../../src/agent/runtime.js";

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

const baseConfig = {
  anthropicApiKey: "test-key",
  agentConfig: {
    name: "TestAgent",
    role: "admin",
    tools: ["db_query"],
    max_concurrent_tasks: 1,
  },
  toolPolicies: {},
};

describe("AgentRuntime", () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new AgentRuntime(baseConfig);
  });

  it("returns text response when no tool calls", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
    });
    // Access the mock client
    (runtime as any).client.messages.create = mockCreate;

    const result = await runtime.chat("hi");
    expect(result.text).toBe("Hello!");
    expect(result.toolCalls).toEqual([]);
  });

  it("invokes tool executor when Claude requests tool use", async () => {
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me query that." },
          { type: "tool_use", id: "call_1", name: "db_query", input: { sql: "SELECT 1" } },
        ],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "The result is 1." }],
        stop_reason: "end_turn",
      });

    (runtime as any).client.messages.create = mockCreate;

    const toolExecutor = vi.fn().mockResolvedValue({
      output: JSON.stringify({ rows: [{ "?column?": 1 }], rowCount: 1 }),
    });

    const result = await runtime.chat("what is 1?", { toolExecutor });
    expect(toolExecutor).toHaveBeenCalledWith("db_query", { sql: "SELECT 1" }, "call_1");
    expect(result.text).toBe("The result is 1.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: "db_query",
      input: { sql: "SELECT 1" },
    });
    // Two API calls: initial + tool result
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("passes tool definitions to the API", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
    });
    (runtime as any).client.messages.create = mockCreate;

    const tools = [{
      name: "db_query",
      description: "Run SQL",
      input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
    }];

    await runtime.chat("hi", { tools });
    expect(mockCreate.mock.calls[0][0].tools).toEqual(tools);
  });

  it("limits tool-use loop to prevent infinite loops", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [
        { type: "tool_use", id: "call_x", name: "db_query", input: { sql: "SELECT 1" } },
      ],
      stop_reason: "tool_use",
    });
    (runtime as any).client.messages.create = mockCreate;

    const toolExecutor = vi.fn().mockResolvedValue({ output: "ok" });

    await expect(runtime.chat("loop", { toolExecutor, maxToolRounds: 3 }))
      .rejects.toThrow("too many tool-use rounds");
  });

  it("handles tool execution errors", async () => {
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        content: [
          { type: "tool_use", id: "call_err", name: "db_query", input: { sql: "BAD" } },
        ],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "Sorry, error." }],
        stop_reason: "end_turn",
      });
    (runtime as any).client.messages.create = mockCreate;

    const toolExecutor = vi.fn().mockResolvedValue({
      output: "relation does not exist",
      isError: true,
    });

    const result = await runtime.chat("bad query", { toolExecutor });
    expect(result.text).toBe("Sorry, error.");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/runtime.test.ts`
Expected: FAIL — `chat()` doesn't accept options, no `toolCalls` in result

**Step 3: Rewrite the runtime**

```typescript
// src/agent/runtime.ts
import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig, ToolPolicies } from "../config/types.js";
import type { ToolDefinition, ToolResult } from "../tools/types.js";
import { buildSystemPrompt } from "./prompt.js";

type ToolExecutorFn = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
) => Promise<ToolResult>;

export interface ChatOptions {
  tools?: ToolDefinition[];
  toolExecutor?: ToolExecutorFn;
  maxToolRounds?: number;
}

export interface ChatResult {
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output: string;
    isError?: boolean;
  }>;
}

interface AgentRuntimeConfig {
  anthropicApiKey: string;
  anthropicBaseUrl?: string;
  agentConfig: AgentConfig;
  toolPolicies: ToolPolicies;
}

export class AgentRuntime {
  private client: Anthropic;
  private systemPrompt: string;
  private conversationHistory: Anthropic.MessageParam[] = [];

  constructor(config: AgentRuntimeConfig) {
    this.client = new Anthropic({
      apiKey: config.anthropicApiKey,
      baseURL: config.anthropicBaseUrl,
    });

    const guardrails: Record<string, string> = {};
    for (const [tool, policy] of Object.entries(config.toolPolicies)) {
      if (policy.guardrails) {
        guardrails[tool] = policy.guardrails;
      }
    }

    this.systemPrompt = buildSystemPrompt({
      agentName: config.agentConfig.name,
      personality: config.agentConfig.personality,
      systemPromptExtra: config.agentConfig.system_prompt_extra,
      guardrails,
    });
  }

  async chat(userMessage: string, options?: ChatOptions): Promise<ChatResult> {
    const maxRounds = options?.maxToolRounds ?? 10;
    const toolCalls: ChatResult["toolCalls"] = [];

    this.conversationHistory.push({ role: "user", content: userMessage });

    for (let round = 0; round <= maxRounds; round++) {
      const params: Anthropic.MessageCreateParams = {
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: this.systemPrompt,
        messages: this.conversationHistory,
      };

      if (options?.tools && options.tools.length > 0) {
        params.tools = options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        }));
      }

      const response = await this.client.messages.create(params);

      // Extract text blocks
      const textParts = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text);

      // Extract tool-use blocks
      const toolUseBlocks = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      // If no tool calls, we're done
      if (toolUseBlocks.length === 0 || response.stop_reason !== "tool_use") {
        const finalText = textParts.join("");
        this.conversationHistory.push({ role: "assistant", content: finalText });
        return { text: finalText, toolCalls };
      }

      // Guard against infinite loops
      if (round === maxRounds) {
        throw new Error("too many tool-use rounds");
      }

      // Store the full assistant response (text + tool_use blocks)
      this.conversationHistory.push({ role: "assistant", content: response.content });

      // Execute each tool call
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        let result: ToolResult;
        if (options?.toolExecutor) {
          result = await options.toolExecutor(
            block.name,
            block.input as Record<string, unknown>,
            block.id,
          );
        } else {
          result = { output: "Tool execution not configured", isError: true };
        }

        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
          output: result.output,
          isError: result.isError,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.output,
          is_error: result.isError,
        });
      }

      this.conversationHistory.push({ role: "user", content: toolResults });
    }

    throw new Error("too many tool-use rounds");
  }

  getHistory(): Anthropic.MessageParam[] {
    return [...this.conversationHistory];
  }

  loadHistory(messages: Anthropic.MessageParam[]): void {
    this.conversationHistory = [...messages];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/runtime.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/agent/runtime.ts src/tools/types.ts tests/agent/runtime.test.ts
git commit -m "feat: agent runtime tool-use loop with Anthropic API"
```

---

### Task 3: Tool Executor with Approval Middleware

Build a `ToolExecutor` class that sits between the agent runtime and actual tools. It classifies each tool call through the `ApprovalEngine`, handles tier 1 (auto-execute), and for tier 2/3 returns a "pending approval" result. This task does NOT wire Slack yet — that's Task 4.

**Files:**
- Create: `src/agent/tool-executor.ts`
- Test: `tests/agent/tool-executor.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/agent/tool-executor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolExecutor } from "../../src/agent/tool-executor.js";
import type { ApprovalEngine, ClassificationResult } from "../../src/approval/engine.js";
import type { AuditLogger } from "../../src/audit/logger.js";

function mockClassify(tier: 1 | 2 | 3): ClassificationResult {
  return {
    tier,
    requiresApproval: tier > 1,
    approver: tier === 1 ? "none" : tier === 2 ? "initiator" : "checker",
    guardrails: null,
  };
}

describe("ToolExecutor", () => {
  let executor: ToolExecutor;
  let mockApprovalEngine: Partial<ApprovalEngine>;
  let mockAuditLogger: Partial<AuditLogger>;
  let mockToolRunner: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockApprovalEngine = {
      classify: vi.fn().mockReturnValue(mockClassify(1)),
      requestApproval: vi.fn().mockResolvedValue({ id: "apr-1", status: "pending" }),
    };
    mockAuditLogger = {
      log: vi.fn().mockResolvedValue(undefined),
    };
    mockToolRunner = vi.fn().mockResolvedValue({ output: '{"rows":[]}', isError: false });
    executor = new ToolExecutor({
      approvalEngine: mockApprovalEngine as ApprovalEngine,
      auditLogger: mockAuditLogger as AuditLogger,
      taskId: "task-1",
      initiatorSlackId: "U123",
      checkerSlackId: null,
      toolRunners: { db_query: mockToolRunner },
    });
  });

  it("auto-executes tier 1 tools", async () => {
    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(1));
    const result = await executor.execute("db_query", { sql: "SELECT 1" }, "call-1");
    expect(result.isError).toBeFalsy();
    expect(mockToolRunner).toHaveBeenCalledWith({ sql: "SELECT 1" });
    expect(mockAuditLogger.log).toHaveBeenCalled();
  });

  it("returns pending approval for tier 2 tools", async () => {
    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(2));
    const result = await executor.execute("db_query", { sql: "UPDATE x SET y=1" }, "call-2");
    expect(result.output).toContain("approval");
    expect(result.needsApproval).toBe(true);
    expect(result.approvalId).toBe("apr-1");
    expect(result.tier).toBe(2);
    expect(mockToolRunner).not.toHaveBeenCalled();
  });

  it("returns pending approval for tier 3 tools", async () => {
    (mockApprovalEngine.classify as ReturnType<typeof vi.fn>).mockReturnValue(mockClassify(3));
    const result = await executor.execute("db_query", { sql: "DROP TABLE x" }, "call-3");
    expect(result.needsApproval).toBe(true);
    expect(result.tier).toBe(3);
    expect(mockToolRunner).not.toHaveBeenCalled();
  });

  it("returns error for unknown tools", async () => {
    const result = await executor.execute("unknown_tool", {}, "call-4");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("unknown_tool");
  });

  it("executes tool after approval is granted", async () => {
    const result = await executor.executeApproved("db_query", { sql: "SELECT 1" }, "U_APPROVER");
    expect(result.isError).toBeFalsy();
    expect(mockToolRunner).toHaveBeenCalledWith({ sql: "SELECT 1" });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tool-executor.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ToolExecutor**

```typescript
// src/agent/tool-executor.ts
import type { ApprovalEngine } from "../approval/engine.js";
import type { AuditLogger } from "../audit/logger.js";
import type { ToolResult } from "../tools/types.js";

type ToolRunnerFn = (input: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolExecutorResult extends ToolResult {
  needsApproval?: boolean;
  approvalId?: string;
  tier?: 1 | 2 | 3;
  approver?: "none" | "initiator" | "checker";
}

interface ToolExecutorConfig {
  approvalEngine: ApprovalEngine;
  auditLogger: AuditLogger;
  taskId: string;
  initiatorSlackId: string;
  checkerSlackId: string | null;
  toolRunners: Record<string, ToolRunnerFn>;
}

export class ToolExecutor {
  private config: ToolExecutorConfig;

  constructor(config: ToolExecutorConfig) {
    this.config = config;
  }

  async execute(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseId: string,
  ): Promise<ToolExecutorResult> {
    const runner = this.config.toolRunners[toolName];
    if (!runner) {
      return {
        output: `Tool "${toolName}" is not available.`,
        isError: true,
      };
    }

    const classification = this.config.approvalEngine.classify(toolName, toolInput);

    if (!classification.requiresApproval) {
      // Tier 1: auto-execute
      const result = await runner(toolInput);
      await this.config.auditLogger.log({
        taskId: this.config.taskId,
        action: "tool_executed",
        actor: "system",
        detail: { toolName, toolInput, tier: classification.tier, autoApproved: true },
      });
      return result;
    }

    // Tier 2 or 3: request approval
    const approval = await this.config.approvalEngine.requestApproval(
      this.config.taskId,
      toolName,
      toolInput,
      classification.tier,
      this.config.initiatorSlackId,
    );

    await this.config.auditLogger.log({
      taskId: this.config.taskId,
      action: "approval_requested",
      actor: this.config.initiatorSlackId,
      detail: {
        toolName,
        toolInput,
        tier: classification.tier,
        approver: classification.approver,
        approvalId: approval.id,
      },
    });

    return {
      output: `This action requires ${classification.approver} approval (tier ${classification.tier}). Approval request created.`,
      needsApproval: true,
      approvalId: approval.id,
      tier: classification.tier,
      approver: classification.approver,
    };
  }

  async executeApproved(
    toolName: string,
    toolInput: Record<string, unknown>,
    approvedBy: string,
  ): Promise<ToolResult> {
    const runner = this.config.toolRunners[toolName];
    if (!runner) {
      return { output: `Tool "${toolName}" is not available.`, isError: true };
    }

    const result = await runner(toolInput);

    await this.config.auditLogger.log({
      taskId: this.config.taskId,
      action: "tool_executed",
      actor: approvedBy,
      detail: { toolName, toolInput, approvedBy },
    });

    return result;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/tool-executor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tool-executor.ts tests/agent/tool-executor.test.ts
git commit -m "feat: ToolExecutor with approval middleware"
```

---

### Task 4: Slack Approval Flow — Post & Wait

Wire the approval flow into Slack. When a tier 2/3 tool call is detected, post an approval request message in the thread, then listen for the initiator (tier 2) or checker (tier 3) to reply with "approve" or "deny". Resume tool execution on approval.

**Files:**
- Create: `src/slack/approval-flow.ts`
- Test: `tests/slack/approval-flow.test.ts`
- Modify: `src/app.ts`

**Step 1: Write the failing test**

```typescript
// tests/slack/approval-flow.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackApprovalFlow } from "../../src/slack/approval-flow.js";

describe("SlackApprovalFlow", () => {
  let flow: SlackApprovalFlow;
  let mockSay: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSay = vi.fn().mockResolvedValue({ ts: "msg-ts" });
    flow = new SlackApprovalFlow();
  });

  it("posts tier 2 approval request mentioning initiator", async () => {
    const msg = await flow.postApprovalRequest({
      say: mockSay,
      threadTs: "thread-1",
      approvalId: "apr-1",
      toolName: "db_query",
      toolInput: { sql: "SELECT * FROM users" },
      tier: 2,
      initiatorSlackId: "U_INIT",
      checkerSlackId: null,
    });

    expect(mockSay).toHaveBeenCalledTimes(1);
    const call = mockSay.mock.calls[0][0];
    expect(call.thread_ts).toBe("thread-1");
    expect(call.text).toContain("<@U_INIT>");
    expect(call.text).toContain("db_query");
    expect(call.text).toContain("approve");
  });

  it("posts tier 3 approval request mentioning checker", async () => {
    await flow.postApprovalRequest({
      say: mockSay,
      threadTs: "thread-1",
      approvalId: "apr-1",
      toolName: "db_write",
      toolInput: { sql: "DELETE FROM logs" },
      tier: 3,
      initiatorSlackId: "U_INIT",
      checkerSlackId: "U_CHECK",
    });

    const call = mockSay.mock.calls[0][0];
    expect(call.text).toContain("<@U_CHECK>");
    expect(call.text).toContain("DELETE FROM logs");
  });

  it("parses 'approve' reply as approved", () => {
    expect(flow.parseDecision("approve")).toBe("approved");
    expect(flow.parseDecision("approved")).toBe("approved");
    expect(flow.parseDecision("yes")).toBe("approved");
    expect(flow.parseDecision("APPROVE")).toBe("approved");
  });

  it("parses 'deny' reply as rejected", () => {
    expect(flow.parseDecision("deny")).toBe("rejected");
    expect(flow.parseDecision("denied")).toBe("rejected");
    expect(flow.parseDecision("reject")).toBe("rejected");
    expect(flow.parseDecision("no")).toBe("rejected");
  });

  it("returns null for unrelated messages", () => {
    expect(flow.parseDecision("what about this?")).toBeNull();
    expect(flow.parseDecision("let me think")).toBeNull();
  });

  it("validates approver for tier 2 (must be initiator)", () => {
    expect(flow.canApprove({ tier: 2, userId: "U_INIT", initiatorSlackId: "U_INIT", checkerSlackId: null })).toBe(true);
    expect(flow.canApprove({ tier: 2, userId: "U_OTHER", initiatorSlackId: "U_INIT", checkerSlackId: null })).toBe(false);
  });

  it("validates approver for tier 3 (must be checker, not initiator)", () => {
    expect(flow.canApprove({ tier: 3, userId: "U_CHECK", initiatorSlackId: "U_INIT", checkerSlackId: "U_CHECK" })).toBe(true);
    expect(flow.canApprove({ tier: 3, userId: "U_INIT", initiatorSlackId: "U_INIT", checkerSlackId: "U_CHECK" })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/approval-flow.test.ts`
Expected: FAIL — module not found

**Step 3: Implement SlackApprovalFlow**

```typescript
// src/slack/approval-flow.ts

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (message: any) => Promise<unknown>;

interface ApprovalRequestParams {
  say: SayFn;
  threadTs: string;
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  tier: 2 | 3;
  initiatorSlackId: string;
  checkerSlackId: string | null;
}

interface CanApproveParams {
  tier: 2 | 3;
  userId: string;
  initiatorSlackId: string;
  checkerSlackId: string | null;
}

export class SlackApprovalFlow {
  async postApprovalRequest(params: ApprovalRequestParams): Promise<void> {
    const approverMention = params.tier === 2
      ? `<@${params.initiatorSlackId}>`
      : params.checkerSlackId
        ? `<@${params.checkerSlackId}>`
        : "a checker";

    const inputSummary = JSON.stringify(params.toolInput, null, 2);
    const truncatedInput = inputSummary.length > 500
      ? inputSummary.slice(0, 500) + "..."
      : inputSummary;

    const text = [
      `⚠️ *Approval Required (Tier ${params.tier})*`,
      ``,
      `Tool: \`${params.toolName}\``,
      `Input:`,
      `\`\`\`${truncatedInput}\`\`\``,
      ``,
      `${approverMention}, please reply with *approve* or *deny*.`,
      `_(approval id: ${params.approvalId})_`,
    ].join("\n");

    await params.say({ text, thread_ts: params.threadTs });
  }

  parseDecision(text: string): "approved" | "rejected" | null {
    const normalized = text.trim().toLowerCase();
    if (["approve", "approved", "yes", "lgtm", "ok"].includes(normalized)) {
      return "approved";
    }
    if (["deny", "denied", "reject", "rejected", "no"].includes(normalized)) {
      return "rejected";
    }
    return null;
  }

  canApprove(params: CanApproveParams): boolean {
    if (params.tier === 2) {
      return params.userId === params.initiatorSlackId;
    }
    // Tier 3: must be checker, cannot be initiator
    if (params.userId === params.initiatorSlackId) return false;
    if (params.checkerSlackId) {
      return params.userId === params.checkerSlackId;
    }
    // If no checker assigned, any non-initiator can approve
    return true;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/approval-flow.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/slack/approval-flow.ts tests/slack/approval-flow.test.ts
git commit -m "feat: Slack approval flow — post request and parse decisions"
```

---

### Task 5: Wire Everything in app.ts — Tool Calls + Approvals + Slack

This is the integration task. Rewire `app.ts` so that:
1. Agent runtime gets tool definitions and a tool executor callback
2. Tool executor uses the approval engine
3. When approval is needed, post in Slack thread and register a pending approval
4. Thread reply handler checks for approval decisions and resumes execution

**Files:**
- Modify: `src/app.ts`
- Modify: `src/config/env.ts` (add `DB_QUERY_CONNECTION_URL` for the tool's target DB)

**Step 1: Update env.ts**

Add to `src/config/env.ts`:
```typescript
  DB_TOOL_CONNECTION_URL: process.env.DB_TOOL_CONNECTION_URL ?? process.env.DATABASE_URL ?? "postgres://vandura:vandura@localhost:5432/vandura",
```

This separates the app's own DB from the DB the tool queries (they may be different in production).

**Step 2: Rewrite app.ts**

Replace the entire `src/app.ts` with the fully wired version. Key changes:
- Create a `PostgresTool` connected to the target DB
- Create a `ToolExecutor` per task with approval middleware
- In `onMention`: pass `tools` and `toolExecutor` callback to `runtime.chat()`
- When `toolExecutor` returns `needsApproval`, post approval request via `SlackApprovalFlow`
- In `onThreadMessage`: check if the reply is an approval decision. If yes, resolve the approval and execute the tool. If no, continue conversation.
- Track pending approvals per thread in a `Map<string, PendingApproval>`.

The full `app.ts` rewrite is large. Here is the complete code:

```typescript
// src/app.ts
import { App } from "@slack/bolt";
import { env } from "./config/env.js";
import { createPool } from "./db/connection.js";
import { runMigrations } from "./db/migrate.js";
import { loadToolPolicies, loadAgents } from "./config/loader.js";
import { SlackGateway } from "./slack/gateway.js";
import { SlackApprovalFlow } from "./slack/approval-flow.js";
import { ThreadManager } from "./threads/manager.js";
import { ApprovalEngine } from "./approval/engine.js";
import { AuditLogger } from "./audit/logger.js";
import { AgentRuntime, type ChatOptions, type ChatResult } from "./agent/runtime.js";
import { ToolExecutor, type ToolExecutorResult } from "./agent/tool-executor.js";
import { PostgresTool } from "./tools/postgres.js";
import { StorageService } from "./storage/s3.js";
import type { ToolResult } from "./tools/types.js";
import path from "node:path";

interface PendingApproval {
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  tier: 2 | 3;
  taskId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SayFn = (msg: any) => Promise<unknown>;

export async function createApp() {
  const configDir = path.join(process.cwd(), "config");
  const toolPolicies = await loadToolPolicies(path.join(configDir, "tool-policies.yml"));
  const agents = await loadAgents(path.join(configDir, "agents.yml"));

  const pool = createPool(env.DATABASE_URL);
  await runMigrations(pool);

  // Target DB pool for the Postgres tool (may differ from app DB)
  const toolDbPool = createPool(env.DB_TOOL_CONNECTION_URL);

  const agentConfig = agents[0];
  const agentRow = await pool.query(
    `INSERT INTO agents (name, role, tools, personality, system_prompt_extra, max_concurrent_tasks)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET role = $2, tools = $3
     RETURNING id`,
    [agentConfig.name, agentConfig.role, JSON.stringify(agentConfig.tools),
     agentConfig.personality ?? null, agentConfig.system_prompt_extra ?? null,
     agentConfig.max_concurrent_tasks]
  );
  const agentId: string = agentRow.rows[0].id;

  const threadManager = new ThreadManager(pool);
  const approvalEngine = new ApprovalEngine(pool, toolPolicies);
  const auditLogger = new AuditLogger(pool);
  const approvalFlow = new SlackApprovalFlow();
  const storage = new StorageService({
    endpoint: env.S3_ENDPOINT, accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET,
    region: env.S3_REGION, signedUrlExpiry: env.S3_SIGNED_URL_EXPIRY,
  });
  await storage.ensureBucket();

  const pgTool = new PostgresTool(toolDbPool);

  const slackApp = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true,
  });
  slackApp.error(async (error) => { console.error("[SLACK ERROR]", error); });
  const gateway = new SlackGateway(slackApp);

  const authResult = await slackApp.client.auth.test();
  if (authResult.user_id) gateway.setBotUserId(authResult.user_id);

  // State: active runtimes + pending approvals per thread
  const activeAgents = new Map<string, AgentRuntime>();
  const activeExecutors = new Map<string, ToolExecutor>();
  const pendingApprovals = new Map<string, PendingApproval>(); // keyed by thread_ts

  // Helper: run agent chat with tools and handle approval flow
  async function runAgentChat(
    runtime: AgentRuntime,
    executor: ToolExecutor,
    task: { id: string; initiatorSlackId: string; checkerSlackId: string | null },
    userMessage: string,
    threadTs: string,
    say: SayFn,
  ): Promise<void> {
    const chatOptions: ChatOptions = {
      tools: [pgTool.definition()],
      toolExecutor: async (toolName, toolInput, toolUseId) => {
        const result = await executor.execute(toolName, toolInput, toolUseId);

        if (result.needsApproval && result.approvalId && result.tier) {
          // Post approval request in thread
          await approvalFlow.postApprovalRequest({
            say,
            threadTs,
            approvalId: result.approvalId,
            toolName,
            toolInput,
            tier: result.tier as 2 | 3,
            initiatorSlackId: task.initiatorSlackId,
            checkerSlackId: task.checkerSlackId,
          });

          // Store pending approval
          pendingApprovals.set(threadTs, {
            approvalId: result.approvalId,
            toolName,
            toolInput,
            toolUseId,
            tier: result.tier as 2 | 3,
            taskId: task.id,
          });

          // Return a message to the agent so it knows to wait
          return {
            output: `Approval requested (tier ${result.tier}). Waiting for ${result.approver} to approve or deny.`,
            isError: false,
          };
        }

        return result as ToolResult;
      },
    };

    const response = await runtime.chat(userMessage, chatOptions);
    await threadManager.addMessage(task.id, "assistant", response.text, {
      toolCalls: response.toolCalls,
    });

    // Upload large responses to S3
    if (response.text.length > 4000) {
      const { signedUrl } = await storage.upload({
        key: `${task.id}/response-${Date.now()}.txt`,
        content: Buffer.from(response.text),
        contentType: "text/plain",
      });
      const preview = response.text.slice(0, 500) + `...\n\n📎 Full response: ${signedUrl}`;
      await say({ text: preview, thread_ts: threadTs });
    } else {
      await say({ text: response.text, thread_ts: threadTs });
    }
  }

  // Handle @mentions — create new task thread
  gateway.onMention(async ({ user, text, channel, ts, say }) => {
    await auditLogger.log({
      action: "mention_received", actor: user, detail: { text, channel },
    });

    await say({ text: "I'm on it! Let me look into this...", thread_ts: ts });

    const task = await threadManager.createTask({
      slackThreadTs: ts, slackChannel: channel, agentId, initiatorSlackId: user,
    });

    const runtime = new AgentRuntime({
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
      agentConfig, toolPolicies,
    });
    activeAgents.set(ts, runtime);

    const executor = new ToolExecutor({
      approvalEngine, auditLogger, taskId: task.id,
      initiatorSlackId: user, checkerSlackId: null,
      toolRunners: {
        db_query: async (input) => {
          const r = await pgTool.execute(input as { sql: string });
          return r.error
            ? { output: r.error, isError: true }
            : { output: JSON.stringify({ rows: r.rows, rowCount: r.rowCount, columns: r.columns }) };
        },
      },
    });
    activeExecutors.set(ts, executor);

    const cleanText = text.replace(/<@[^>]+>/g, "").trim();
    await threadManager.addMessage(task.id, "user", cleanText, null);

    try {
      await runAgentChat(runtime, executor, task, cleanText, ts, say);
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts: ts });
    }
  });

  // Handle thread replies — approval decisions or continued conversation
  gateway.onThreadMessage(async ({ user, text, channel, thread_ts, say }) => {
    const task = await threadManager.findByThread(channel, thread_ts);
    if (!task) return;

    // Check if this is an approval decision
    const pending = pendingApprovals.get(thread_ts);
    if (pending) {
      const decision = approvalFlow.parseDecision(text);
      if (decision) {
        const canApprove = approvalFlow.canApprove({
          tier: pending.tier,
          userId: user,
          initiatorSlackId: task.initiatorSlackId,
          checkerSlackId: task.checkerSlackId,
        });

        if (!canApprove) {
          await say({
            text: pending.tier === 2
              ? `Only <@${task.initiatorSlackId}> can approve this (tier 2).`
              : `Only the checker can approve this (tier 3).`,
            thread_ts,
          });
          return;
        }

        // Resolve the approval
        await approvalEngine.resolve(pending.approvalId, decision, user);
        pendingApprovals.delete(thread_ts);

        if (decision === "rejected") {
          await say({ text: "❌ Action denied. The tool will not be executed.", thread_ts });
          await auditLogger.log({
            taskId: task.id, action: "approval_rejected", actor: user,
            detail: { toolName: pending.toolName, approvalId: pending.approvalId },
          });
          return;
        }

        // Approved — execute the tool
        await say({ text: "✅ Approved. Executing...", thread_ts });
        const executor = activeExecutors.get(thread_ts);
        if (!executor) return;

        const toolResult = await executor.executeApproved(
          pending.toolName, pending.toolInput, user,
        );

        // Feed result back to agent
        const runtime = activeAgents.get(thread_ts);
        if (!runtime) return;

        try {
          const agentMsg = `Tool "${pending.toolName}" was approved and executed. Result: ${toolResult.output}`;
          await threadManager.addMessage(task.id, "user", agentMsg, { source: "approval_result" });
          await runAgentChat(runtime, executor, task, agentMsg, thread_ts, say);
        } catch (err) {
          const errorMsg = `Error after approval: ${err instanceof Error ? err.message : "unknown"}`;
          await say({ text: errorMsg, thread_ts });
        }
        return;
      }
    }

    // Regular conversation message
    const runtime = activeAgents.get(thread_ts);
    if (!runtime) return;

    const executor = activeExecutors.get(thread_ts);
    if (!executor) return;

    await threadManager.addMessage(task.id, "user", text, null);

    try {
      await runAgentChat(runtime, executor, task, text, thread_ts, say);
    } catch (err) {
      const errorMsg = `Sorry, I encountered an error: ${err instanceof Error ? err.message : "unknown error"}`;
      await say({ text: errorMsg, thread_ts });
    }
  });

  return {
    start: () => gateway.start(),
    pool, toolDbPool, gateway, threadManager,
    approvalEngine, auditLogger, storage,
  };
}
```

**Step 3: Run typecheck and existing tests**

Run: `npx tsc --noEmit && npx vitest run --exclude 'tests/e2e/**' --exclude 'tests/db/**' --exclude 'tests/audit/**' --exclude 'tests/approval/**' --exclude 'tests/threads/**' --exclude 'tests/storage/**'`
Expected: PASS

**Step 4: Update the app.test.ts smoke test**

Update `tests/app.test.ts` to verify the new `toolDbPool` is returned and that the exports match.

**Step 5: Commit**

```bash
git add src/app.ts src/config/env.ts tests/app.test.ts
git commit -m "feat: wire tool execution + approval flow into app"
```

---

### Task 6: Checker Nomination Flow

After an @mention creates a task, the agent should ask who the checker should be. The initiator replies with `@username` and the checker is set on the task.

**Files:**
- Create: `src/slack/checker-flow.ts`
- Test: `tests/slack/checker-flow.test.ts`
- Modify: `src/app.ts` — add checker nomination to onMention and onThreadMessage

**Step 1: Write the failing test**

```typescript
// tests/slack/checker-flow.test.ts
import { describe, it, expect } from "vitest";
import { CheckerFlow } from "../../src/slack/checker-flow.js";

describe("CheckerFlow", () => {
  const flow = new CheckerFlow();

  it("extracts user ID from @mention in text", () => {
    expect(flow.extractCheckerFromReply("checker is <@U0ABC123>")).toBe("U0ABC123");
    expect(flow.extractCheckerFromReply("<@U0XYZ789> should check")).toBe("U0XYZ789");
  });

  it("returns null when no @mention found", () => {
    expect(flow.extractCheckerFromReply("no checker needed")).toBeNull();
    expect(flow.extractCheckerFromReply("skip")).toBeNull();
  });

  it("returns 'skip' for skip keywords", () => {
    expect(flow.extractCheckerFromReply("skip")).toBe("skip");
    expect(flow.extractCheckerFromReply("none")).toBe("skip");
    expect(flow.extractCheckerFromReply("no checker")).toBe("skip");
  });

  it("builds the checker nomination prompt", () => {
    const msg = flow.buildNominationPrompt();
    expect(msg).toContain("checker");
    expect(msg).toContain("skip");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack/checker-flow.test.ts`
Expected: FAIL

**Step 3: Implement CheckerFlow**

```typescript
// src/slack/checker-flow.ts
export class CheckerFlow {
  extractCheckerFromReply(text: string): string | "skip" | null {
    const normalized = text.trim().toLowerCase();
    if (["skip", "none", "no checker", "n/a"].includes(normalized)) {
      return "skip";
    }
    const match = text.match(/<@(U[A-Z0-9]+)>/);
    return match ? match[1] : null;
  }

  buildNominationPrompt(): string {
    return "Who should be the checker for this task? Reply with @username, or say *skip* if no checker is needed.";
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack/checker-flow.test.ts`
Expected: PASS

**Step 5: Wire into app.ts**

In `onMention`, after creating the task and before processing the message:
- If `toolPolicies` contain any tier 3 tools, ask for checker nomination
- Store a "pending_checker" flag per thread
- In `onThreadMessage`, before processing approvals or conversation, check if checker is pending

In `app.ts`, add:
```typescript
const pendingCheckerNomination = new Set<string>(); // thread_ts values awaiting checker
```

In the `onMention` handler, after `await say({ text: "I'm on it!..." })`, add:
```typescript
// Ask for checker nomination if any tier 3 tools exist
const hasHighTierTools = Object.values(toolPolicies).some(p => p.tier === 3);
if (hasHighTierTools) {
  const checkerFlow = new CheckerFlow();
  await say({ text: checkerFlow.buildNominationPrompt(), thread_ts: ts });
  pendingCheckerNomination.add(ts);
}
```

In the `onThreadMessage` handler, before the approval check:
```typescript
// Check if this is a checker nomination reply
if (pendingCheckerNomination.has(thread_ts)) {
  const checkerFlow = new CheckerFlow();
  const checkerId = checkerFlow.extractCheckerFromReply(text);
  if (checkerId) {
    pendingCheckerNomination.delete(thread_ts);
    if (checkerId !== "skip") {
      await threadManager.setChecker(task.id, checkerId);
      // Update the executor's checker reference
      // (create a new executor config or add a setter)
      await say({ text: `✅ <@${checkerId}> set as checker for this task.`, thread_ts });
    } else {
      await say({ text: "No checker assigned. Tier 3 actions will require any channel member to approve.", thread_ts });
    }
    return;
  }
}
```

**Step 6: Commit**

```bash
git add src/slack/checker-flow.ts tests/slack/checker-flow.test.ts src/app.ts
git commit -m "feat: checker nomination flow in Slack threads"
```

---

### Task 7: Task Close & Summary

Add the ability to close a task via Slack commands ("done", "close", "cancel") and post a summary of what was done.

**Files:**
- Create: `src/slack/task-lifecycle.ts`
- Test: `tests/slack/task-lifecycle.test.ts`
- Modify: `src/app.ts`

**Step 1: Write the failing test**

```typescript
// tests/slack/task-lifecycle.test.ts
import { describe, it, expect } from "vitest";
import { TaskLifecycle } from "../../src/slack/task-lifecycle.js";

describe("TaskLifecycle", () => {
  const lifecycle = new TaskLifecycle();

  it("detects close commands", () => {
    expect(lifecycle.parseCommand("done")).toBe("completed");
    expect(lifecycle.parseCommand("close")).toBe("completed");
    expect(lifecycle.parseCommand("task complete")).toBe("completed");
    expect(lifecycle.parseCommand("cancel")).toBe("cancelled");
    expect(lifecycle.parseCommand("abort")).toBe("cancelled");
  });

  it("returns null for non-commands", () => {
    expect(lifecycle.parseCommand("what about this?")).toBeNull();
    expect(lifecycle.parseCommand("do the thing")).toBeNull();
  });

  it("builds a task summary", () => {
    const summary = lifecycle.buildSummary({
      taskId: "t-1",
      status: "completed",
      messageCount: 8,
      toolCallCount: 3,
      approvalCount: 1,
      duration: "5m 30s",
    });
    expect(summary).toContain("completed");
    expect(summary).toContain("8 messages");
    expect(summary).toContain("3 tool calls");
    expect(summary).toContain("1 approval");
  });
});
```

**Step 2: Implement**

```typescript
// src/slack/task-lifecycle.ts
interface SummaryParams {
  taskId: string;
  status: "completed" | "cancelled";
  messageCount: number;
  toolCallCount: number;
  approvalCount: number;
  duration: string;
}

export class TaskLifecycle {
  parseCommand(text: string): "completed" | "cancelled" | null {
    const normalized = text.trim().toLowerCase();
    if (["done", "close", "task complete", "finish", "complete"].includes(normalized)) {
      return "completed";
    }
    if (["cancel", "abort", "stop"].includes(normalized)) {
      return "cancelled";
    }
    return null;
  }

  buildSummary(params: SummaryParams): string {
    const icon = params.status === "completed" ? "✅" : "🚫";
    return [
      `${icon} *Task ${params.status}*`,
      ``,
      `• ${params.messageCount} messages exchanged`,
      `• ${params.toolCallCount} tool calls executed`,
      `• ${params.approvalCount} approval(s) processed`,
      `• Duration: ${params.duration}`,
      ``,
      `_Task ID: ${params.taskId}_`,
    ].join("\n");
  }
}
```

**Step 3: Wire into app.ts**

In `onThreadMessage`, before the approval check and conversation handling, add:
```typescript
const taskLifecycle = new TaskLifecycle();
const closeCommand = taskLifecycle.parseCommand(text);
if (closeCommand) {
  await threadManager.closeTask(task.id, closeCommand);
  activeAgents.delete(thread_ts);
  activeExecutors.delete(thread_ts);
  pendingApprovals.delete(thread_ts);

  const messages = await threadManager.getMessages(task.id);
  const toolCallCount = messages.filter(m => m.metadata?.toolCalls).length;
  const approvals = await approvalEngine.getPendingByTask(task.id); // get all, not just pending
  const duration = formatDuration(task.createdAt, new Date());

  const summary = taskLifecycle.buildSummary({
    taskId: task.id, status: closeCommand,
    messageCount: messages.length, toolCallCount,
    approvalCount: approvals.length, duration,
  });
  await say({ text: summary, thread_ts });
  return;
}
```

Add a helper function:
```typescript
function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/slack/task-lifecycle.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/slack/task-lifecycle.ts tests/slack/task-lifecycle.test.ts src/app.ts
git commit -m "feat: task close commands and summary"
```

---

### Task 8: Dynamic Tier Classification (EXPLAIN-based)

When a tool policy has `tier: "dynamic"`, run EXPLAIN on the query before executing. Classify based on estimated rows and scan type.

**Files:**
- Modify: `src/approval/engine.ts`
- Test: `tests/approval/dynamic-tier.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/approval/dynamic-tier.test.ts
import { describe, it, expect, vi } from "vitest";
import { ApprovalEngine } from "../../src/approval/engine.js";
import type { Pool } from "../../src/db/connection.js";

describe("Dynamic tier classification", () => {
  const mockPool = { query: vi.fn() } as unknown as Pool;
  const policies = {
    db_query: {
      tier: "dynamic" as const,
      guardrails: "Run EXPLAIN first.",
      checker: "peer-based" as const,
    },
  };
  const engine = new ApprovalEngine(mockPool, policies);

  it("classifies as tier 1 for small queries", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 50, hasSeqScan: false });
    expect(result.tier).toBe(1);
    expect(result.requiresApproval).toBe(false);
  });

  it("classifies as tier 2 for large queries", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 5000, hasSeqScan: false });
    expect(result.tier).toBe(2);
    expect(result.requiresApproval).toBe(true);
  });

  it("classifies as tier 2 for sequential scans", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 50, hasSeqScan: true });
    expect(result.tier).toBe(2);
  });

  it("classifies as tier 3 for very large queries", () => {
    const result = engine.classifyDynamic("db_query", { estimatedRows: 100_000, hasSeqScan: true });
    expect(result.tier).toBe(3);
  });

  it("falls back to tier 3 for dynamic policies when classify is called", () => {
    const result = engine.classify("db_query", {});
    expect(result.tier).toBe(3);
    expect(result.requiresApproval).toBe(true);
  });
});
```

**Step 2: Add classifyDynamic to ApprovalEngine**

Add to `src/approval/engine.ts`:

```typescript
  classifyDynamic(
    toolName: string,
    metrics: { estimatedRows: number; hasSeqScan: boolean },
  ): ClassificationResult {
    const policy = this.policies[toolName] ?? this.policies["_default"];
    const guardrails = policy?.guardrails ?? null;

    if (metrics.estimatedRows > 50_000 || (metrics.estimatedRows > 10_000 && metrics.hasSeqScan)) {
      return { tier: 3, requiresApproval: true, approver: "checker", guardrails };
    }
    if (metrics.estimatedRows > 1000 || metrics.hasSeqScan) {
      return { tier: 2, requiresApproval: true, approver: "initiator", guardrails };
    }
    return { tier: 1, requiresApproval: false, approver: "none", guardrails };
  }
```

Also update `classify()` — when `policy.tier === "dynamic"`, fall back to tier 3 (safest default since we don't have EXPLAIN metrics yet):
```typescript
    const tier = typeof policy.tier === "number" ? policy.tier : 3;
```
This already exists in the current code — no change needed.

**Step 3: Wire into ToolExecutor**

In the tool executor's `execute()` method for `db_query`, before classifying:
1. Check if the policy tier is `"dynamic"`
2. If so, run `pgTool.explain(input.sql)` to get metrics
3. Call `approvalEngine.classifyDynamic()` instead of `classify()`

This wiring happens in `app.ts` where the `toolRunners` are configured.

**Step 4: Run tests**

Run: `npx vitest run tests/approval/dynamic-tier.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/approval/engine.ts tests/approval/dynamic-tier.test.ts
git commit -m "feat: dynamic tier classification with EXPLAIN metrics"
```

---

### Task 9: Health Endpoint

Add a `/health` HTTP endpoint that reports the status of all services.

**Files:**
- Create: `src/health.ts`
- Test: `tests/health.test.ts`
- Modify: `src/app.ts`

**Step 1: Write the failing test**

```typescript
// tests/health.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildHealthCheck } from "../../src/health.js";

describe("Health check", () => {
  it("returns ok when all services are healthy", async () => {
    const check = buildHealthCheck({
      pool: { query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }) } as any,
      storage: { ensureBucket: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const result = await check();
    expect(result.status).toBe("ok");
    expect(result.database).toBe("connected");
    expect(result.storage).toBe("connected");
  });

  it("returns degraded when a service is down", async () => {
    const check = buildHealthCheck({
      pool: { query: vi.fn().mockRejectedValue(new Error("connection refused")) } as any,
      storage: { ensureBucket: vi.fn().mockResolvedValue(undefined) } as any,
    });
    const result = await check();
    expect(result.status).toBe("degraded");
    expect(result.database).toBe("error: connection refused");
  });
});
```

**Step 2: Implement health check**

```typescript
// src/health.ts
import type { Pool } from "./db/connection.js";
import type { StorageService } from "./storage/s3.js";
import { createServer, type Server } from "node:http";

interface HealthDeps {
  pool: Pool;
  storage: StorageService;
}

interface HealthResult {
  status: "ok" | "degraded";
  database: string;
  storage: string;
  uptime: number;
}

export function buildHealthCheck(deps: HealthDeps): () => Promise<HealthResult> {
  const startTime = Date.now();

  return async (): Promise<HealthResult> => {
    let dbStatus = "connected";
    let storageStatus = "connected";
    let allOk = true;

    try {
      await deps.pool.query("SELECT 1");
    } catch (err) {
      dbStatus = `error: ${err instanceof Error ? err.message : "unknown"}`;
      allOk = false;
    }

    try {
      await deps.storage.ensureBucket();
    } catch (err) {
      storageStatus = `error: ${err instanceof Error ? err.message : "unknown"}`;
      allOk = false;
    }

    return {
      status: allOk ? "ok" : "degraded",
      database: dbStatus,
      storage: storageStatus,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  };
}

export function startHealthServer(
  healthCheck: () => Promise<HealthResult>,
  port = 3000,
): Server {
  const server = createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      const result = await healthCheck();
      const status = result.status === "ok" ? 200 : 503;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(port);
  return server;
}
```

**Step 3: Wire into app.ts**

Add to end of `createApp()`:
```typescript
  const healthCheck = buildHealthCheck({ pool, storage });

  return {
    start: async () => {
      await gateway.start();
      startHealthServer(healthCheck);
    },
    // ... existing exports
    healthCheck,
  };
```

**Step 4: Run tests**

Run: `npx vitest run tests/health.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/health.ts tests/health.test.ts src/app.ts
git commit -m "feat: /health endpoint with service status"
```

---

### Task 10: Kubernetes Deployment Manifests

Create K8s manifests for production deployment.

**Files:**
- Create: `k8s/namespace.yml`
- Create: `k8s/deployment.yml`
- Create: `k8s/service.yml`
- Create: `k8s/configmap.yml`
- Create: `k8s/secrets.example.yml`

**Step 1: Create namespace**

```yaml
# k8s/namespace.yml
apiVersion: v1
kind: Namespace
metadata:
  name: vandura
```

**Step 2: Create ConfigMap**

```yaml
# k8s/configmap.yml
apiVersion: v1
kind: ConfigMap
metadata:
  name: vandura-config
  namespace: vandura
data:
  S3_REGION: "us-east-1"
  S3_BUCKET: "vandura-results"
  S3_SIGNED_URL_EXPIRY: "86400"
  KMS_PROVIDER: "local"
```

**Step 3: Create secrets example**

```yaml
# k8s/secrets.example.yml
# Copy this file, fill in real values, and apply with:
#   kubectl apply -f k8s/secrets.yml
apiVersion: v1
kind: Secret
metadata:
  name: vandura-secrets
  namespace: vandura
type: Opaque
stringData:
  ANTHROPIC_API_KEY: "sk-ant-..."
  ANTHROPIC_BASE_URL: ""
  SLACK_BOT_TOKEN: "xoxb-..."
  SLACK_APP_TOKEN: "xapp-..."
  DATABASE_URL: "postgres://user:pass@host:5432/vandura"
  DB_TOOL_CONNECTION_URL: "postgres://user:pass@host:5432/target_db"
  S3_ENDPOINT: "https://storage.googleapis.com"
  S3_ACCESS_KEY: "..."
  S3_SECRET_KEY: "..."
```

**Step 4: Create Deployment**

```yaml
# k8s/deployment.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vandura
  namespace: vandura
  labels:
    app: vandura
spec:
  replicas: 1  # Socket Mode = single connection per bot
  selector:
    matchLabels:
      app: vandura
  template:
    metadata:
      labels:
        app: vandura
    spec:
      containers:
        - name: vandura
          image: ghcr.io/barockok/vandura:latest
          ports:
            - containerPort: 3000
              name: health
          envFrom:
            - configMapRef:
                name: vandura-config
            - secretRef:
                name: vandura-secrets
          livenessProbe:
            httpGet:
              path: /health
              port: health
            initialDelaySeconds: 15
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: health
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests:
              memory: "256Mi"
              cpu: "100m"
            limits:
              memory: "512Mi"
              cpu: "500m"
      restartPolicy: Always
```

**Step 5: Create Service**

```yaml
# k8s/service.yml
apiVersion: v1
kind: Service
metadata:
  name: vandura
  namespace: vandura
spec:
  selector:
    app: vandura
  ports:
    - port: 3000
      targetPort: health
      name: health
  type: ClusterIP
```

**Step 6: Update Dockerfile to copy config files**

Modify `Dockerfile` — add config copy:
```dockerfile
COPY --from=build /app/config ./config
COPY --from=build /app/src/db/migrations ./src/db/migrations
```

**Step 7: Commit**

```bash
git add k8s/ Dockerfile
git commit -m "feat: Kubernetes deployment manifests"
```

---

### Task 11: E2E Test Update — Tool Execution Flow

Update the E2E Slack test to verify the full tool execution + approval flow.

**Files:**
- Modify: `tests/e2e/slack-flow.test.ts`

**Step 1: Add a new test case**

Add a test that:
1. Posts `@vandura show me all tables in the database`
2. Waits for the bot to execute `db_query` (tier 1 / dynamic tier based on EXPLAIN)
3. Verifies the response contains table data
4. Checks the `approvals` table if an approval was needed

**Step 2: Add an approval flow test**

Add a test that:
1. Posts `@vandura run: DELETE FROM audit_log WHERE created_at < '2020-01-01'`
2. Waits for approval request message in thread
3. Posts "approve" as the user
4. Verifies the tool was executed after approval

**Step 3: Run E2E test**

Run: `npx vitest run tests/e2e/slack-flow.test.ts` (with dev server running)

**Step 4: Commit**

```bash
git add tests/e2e/slack-flow.test.ts
git commit -m "test: E2E tests for tool execution and approval flow"
```

---

### Task 12: Final Cleanup & CI Update

1. Ensure `npm test` excludes E2E tests by default (they need a running app)
2. Update CI to run unit tests separately from E2E
3. Add `test:e2e:slack` script to `package.json`
4. Clean up any remaining debug logs

**Files:**
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml`

**Step 1: Update vitest.config.ts to exclude E2E by default**

```typescript
export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
});
```

**Step 2: Add E2E script to package.json**

```json
"test:e2e:slack": "vitest run tests/e2e/slack-flow.test.ts"
```

**Step 3: Commit**

```bash
git add package.json vitest.config.ts .github/workflows/ci.yml
git commit -m "chore: CI updates, exclude E2E from default test run"
```

---

## Summary

| Task | What | Depends On |
|------|------|------------|
| 1 | Postgres Tool (SQL executor) | — |
| 2 | Agent Runtime tool-use loop | Task 1 |
| 3 | ToolExecutor with approval middleware | Task 1 |
| 4 | Slack approval flow (post & parse) | — |
| 5 | Wire everything in app.ts | Tasks 1-4 |
| 6 | Checker nomination flow | Task 5 |
| 7 | Task close & summary | Task 5 |
| 8 | Dynamic tier classification (EXPLAIN) | Task 3 |
| 9 | Health endpoint | — |
| 10 | K8s deployment manifests | Task 9 |
| 11 | E2E test update | Task 5 |
| 12 | Final cleanup & CI | All |
