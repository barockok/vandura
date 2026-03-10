# Remove Tool Policy Duplication

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `tool-policies.yml` the single source of truth for tiers and guardrails; `mcp-servers.yml` owns only server connection details.

**Architecture:** Remove `tools[]` arrays from `mcp-servers.yml`. Remove tier/guardrail extraction from `mcp-loader.ts`. Add a `getAllGuardrails()` export to `permissions.ts`. Update `sdk-runtime.ts` to build guardrails from `permissions.ts` instead of `mcpConfig.toolTiers`.

**Tech Stack:** TypeScript, YAML config, Vitest

---

### Task 1: Add `getAllGuardrails()` to `permissions.ts`

**Files:**
- Modify: `src/agent/permissions.ts`

**Step 1: Add the function after `getToolTier` (after line 87)**

```typescript
/**
 * Get all guardrails from loaded tool policies
 */
export function getAllGuardrails(): Record<string, string> {
  if (!toolPolicies) {
    throw new Error("Tool policies not loaded. Call loadToolPolicies() first.");
  }

  const guardrails: Record<string, string> = {};
  for (const [toolName, policy] of toolPolicies.entries()) {
    if (policy.guardrails) {
      guardrails[toolName] = policy.guardrails;
    }
  }
  return guardrails;
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

---

### Task 2: Update `sdk-runtime.ts` to use `permissions.ts` for guardrails

**Files:**
- Modify: `src/agent/sdk-runtime.ts`

**Step 1: Update import — replace `LoadedMcpConfig` type usage**

Change the import at line 6 from:
```typescript
import type { LoadedMcpConfig } from "./mcp-loader.js";
```
to:
```typescript
import type { LoadedMcpConfig } from "./mcp-loader.js";
import { getAllGuardrails } from "./permissions.js";
```

**Step 2: Replace guardrails construction in `createQueryOptions` (lines 49-55)**

Replace:
```typescript
    // Build guardrails from MCP config tool tiers
    const guardrails: Record<string, string> = {};
    for (const [toolName, info] of mcpConfig.toolTiers.entries()) {
      if (info.guardrails) {
        guardrails[toolName] = info.guardrails;
      }
    }
```

With:
```typescript
    // Build guardrails from tool-policies.yml (single source of truth)
    const guardrails = getAllGuardrails();
```

**Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

---

### Task 3: Remove `toolTiers` from `mcp-loader.ts`

**Files:**
- Modify: `src/agent/mcp-loader.ts`

**Step 1: Simplify `LoadedMcpConfig` interface (line 27-30)**

Replace:
```typescript
export interface LoadedMcpConfig {
  servers: Record<string, SdkMcpServerConfig>;
  toolTiers: Map<string, { tier: 1 | 2 | 3; serverName: string; originalName: string; guardrails?: string }>;
}
```

With:
```typescript
export interface LoadedMcpConfig {
  servers: Record<string, SdkMcpServerConfig>;
}
```

**Step 2: Remove `toolTiers` map creation and population (lines 52, 87-97, 100)**

Remove the `toolTiers` map initialization:
```typescript
  const toolTiers = new Map<string, { tier: 1 | 2 | 3; serverName: string; originalName: string; guardrails?: string }>();
```

Remove the tool tier storage block inside the server loop:
```typescript
    // Store tool tier info
    if (serverConfig.tools) {
      for (const tool of serverConfig.tools) {
        toolTiers.set(tool.name, {
          tier: tool.tier,
          serverName,
          originalName: tool.name,
          guardrails: tool.guardrails,
        });
      }
    }
```

Change the return to:
```typescript
  return { servers };
```

**Step 3: Remove `getToolTier` and `getToolInfo` functions (lines 103-122)**

Delete both exported functions entirely.

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

---

### Task 4: Remove `tools` from `McpServerConfig` type and `McpToolConfig`

**Files:**
- Modify: `src/mcp/types.ts`

**Step 1: Remove `McpToolConfig` interface and `tools` field**

Replace entire file with:
```typescript
export interface McpServerConfig {
  name: string;
  type: "stdio" | "sse" | "websocket";
  command?: string;
  args?: string[];
  endpoint?: string;
  auth?: "none" | "oauth" | "api-key";
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface DiscoveredTool {
  serverName: string;
  originalName: string;
  tier: 1 | 2 | 3;
  guardrails?: string;
  definition: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
}
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

---

### Task 5: Strip `tools[]` from `config/mcp-servers.yml`

**Files:**
- Modify: `config/mcp-servers.yml`

**Step 1: Remove tools arrays from all server entries**

Replace entire file with:
```yaml
servers:
  # PostgreSQL MCP Server - read/write database access
  postgres:
    name: "PostgreSQL"
    type: "stdio"
    command: "npx"
    args:
      - "-y"
      - "@modelcontextprotocol/server-postgres"
      - "${DB_TOOL_CONNECTION_URL}"

  # Grafana MCP Server - dashboard and metrics access
  grafana:
    name: "Grafana"
    type: "stdio"
    command: "npx"
    args:
      - "-y"
      - "@leval/mcp-grafana"
    env:
      GRAFANA_URL: "${GRAFANA_URL}"
      GRAFANA_API_KEY: "${GRAFANA_API_KEY}"
```

**Step 2: Run tests**

Run: `npm test`
Expected: All tests PASS

---

### Task 6: Run full verification and commit

**Step 1: Run all checks**

Run: `npm run typecheck && npm run lint && npm test`
Expected: All PASS

**Step 2: Commit**

```bash
git add src/agent/permissions.ts src/agent/sdk-runtime.ts src/agent/mcp-loader.ts src/mcp/types.ts config/mcp-servers.yml
git commit -m "refactor: make tool-policies.yml single source of truth for tiers and guardrails

Remove tier/guardrails duplication from mcp-servers.yml and mcp-loader.ts.
All policy lookups now go through permissions.ts."
```
