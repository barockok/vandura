# Architecture: BullMQ Workers with Claude Agent SDK

## Overview

Refactor Vandura from a monolithic Slack app to a worker-based architecture using:
- **BullMQ** for job queue (Redis-backed, Sidekiq-like)
- **Claude Agent SDK** for agent runtime with native MCP support
- **Ephemeral workers** - one session per job, exit when awaiting approval
- **Interrupt/Resume pattern** for Slack approval flow

## Architecture Diagram

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Slack Gateway  │────▶│  BullMQ Queue   │────▶│    Workers      │
│  (WebSocket)    │     │  (Redis)        │     │  (SDK query())  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Session Store  │     │  Job Scheduler  │     │   MCP Servers   │
│  (PostgreSQL)   │     │  (BullMQ)       │     │   (stdio)       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## Components

### 1. Slack Gateway (`src/slack/gateway.ts`)

Lightweight WebSocket client that:
- Receives messages from Slack
- Creates jobs in BullMQ queue
- No business logic

```typescript
// Message received → queue job
slackApp.event('app_mention', async ({ event, say }) => {
  await queue.add('start_session', {
    channel_id: event.channel,
    user_id: event.user,
    message: event.text,
    thread_ts: event.thread_ts,
  });
});
```

### 2. BullMQ Queue (`src/queue/`)

**Job Types:**

| Job Name | Purpose | Data |
|----------|---------|------|
| `start_session` | New conversation | `{ channel_id, user_id, message, thread_ts }` |
| `continue_session` | User reply | `{ session_id, message }` |
| `approve_tool` | Tool approval decision | `{ session_id, tool_use_id, decision, approver_id }` |

**Queue Config:**
```typescript
const queue = new Queue('vandura', {
  connection: new Redis(process.env.REDIS_URL),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});
```

### 3. Workers (`src/queue/worker.ts`)

Ephemeral workers that:
- Process one job at a time
- Run SDK `query()` for agent session
- Interrupt when approval needed
- Exit when done or awaiting approval

```typescript
async function processJob(job: Job) {
  const { name, data } = job;

  if (name === 'start_session') {
    const session = await createSession(data);
    const query = sdk.query({
      prompt: data.message,
      cwd: session.sandboxPath,
      resume: session.id,
      mcpServers: loadMcpServers(),
      canUseTool: (toolName, input, opts) =>
        handlePermission(session, toolName, input, opts),
      persistSession: true,
    });

    await processQueryStream(query, session, data.channel_id);
  }

  if (name === 'approve_tool') {
    await resumeWithApproval(data.session_id, data.decision);
  }
}
```

### 4. Agent Runtime (`src/agent/runtime.ts`)

SDK query() wrapper with:
- MCP server configuration
- Permission callback
- Message streaming
- Interrupt/resume logic

```typescript
async function processQueryStream(query: Query, session: Session, channelId: string) {
  try {
    for await (const msg of query) {
      switch (msg.type) {
        case 'assistant':
          await sendToSlack(channelId, msg.message.content);
          break;

        case 'result':
          // Session complete
          await updateSessionStatus(session.id, 'completed');
          break;
      }
    }
  } catch (err) {
    if (err.code === 'INTERRUPTED_FOR_APPROVAL') {
      // Worker exits, will be resumed by approve_tool job
      await updateSessionStatus(session.id, 'awaiting_approval');
    } else {
      throw err;
    }
  }
}
```

### 5. Permission Handler (`src/agent/permissions.ts`)

Handles tool approval flow:

```typescript
async function handlePermission(
  session: Session,
  toolName: string,
  input: Record<string, unknown>,
  opts: { toolUseID: string }
): Promise<PermissionResult> {
  const tier = getToolTier(toolName);

  if (tier === 1) {
    // Auto-approve
    return { behavior: 'allow' };
  }

  // Tier 2/3: Request approval
  await storePendingApproval({
    session_id: session.id,
    tool_name: toolName,
    tool_input: input,
    tool_use_id: opts.toolUseID,
    tier,
  });

  await sendApprovalRequest(session.channel_id, toolName, input, tier);

  // Return deny to trigger interrupt
  return { behavior: 'deny', interrupt: true };
}

async function resumeWithApproval(sessionId: string, decision: 'allow' | 'deny') {
  const approval = await getPendingApproval(sessionId);

  if (decision === 'allow') {
    // Resume session with tool allowed
    const query = sdk.query({
      resume: sessionId,
      allowedTools: [approval.tool_name],
      // ...
    });
    await processQueryStream(query, session, session.channel_id);
  } else {
    // Resume and deny
    const query = sdk.query({
      resume: sessionId,
      disallowedTools: [approval.tool_name],
      // ...
    });
    await processQueryStream(query, session, session.channel_id);
  }
}
```

## Sandbox Directories

Each session gets an isolated working directory:

```
~/.claude/sessions/
├── 2026-03-08/           # Date partitioned
│   ├── {session-uuid-1}/
│   │   ├── .claude/      # SDK session state
│   │   └── workspace/    # Agent's working directory
│   └── {session-uuid-2}/
└── 2026-03-09/
    └── {session-uuid-3}/
```

**Creation:**
```typescript
function createSession(data: JobData): Session {
  const id = uuidv4();
  const date = new Date().toISOString().split('T')[0];
  const sandboxPath = path.join(
    process.env.CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions'),
    date,
    id
  );

  fs.mkdirSync(path.join(sandboxPath, 'workspace'), { recursive: true });

  return {
    id,
    sandboxPath,
    channelId: data.channel_id,
    userId: data.user_id,
    threadTs: data.thread_ts,
    status: 'active',
    createdAt: new Date(),
  };
}
```

## Database Schema

### Sessions Table
```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_ts TEXT,
  sandbox_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Pending Approvals Table
```sql
CREATE TABLE pending_approvals (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES sessions(id),
  tool_name TEXT NOT NULL,
  tool_input JSONB NOT NULL,
  tool_use_id TEXT NOT NULL,
  tier INT NOT NULL,
  requested_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  decision TEXT,
  approver_id TEXT
);
```

## MCP Configuration

Convert `config/mcp-servers.yml` to SDK format:

```yaml
# config/mcp-servers.yml (existing)
servers:
  postgres:
    type: "stdio"
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"]
    tools:
      - name: "query"
        tier: 1
```

```typescript
// Load into SDK format
function loadMcpServers(): Record<string, McpServerConfig> {
  const config = yaml.parse(fs.readFileSync('config/mcp-servers.yml', 'utf-8'));
  const servers: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(config.servers)) {
    if (server.type === 'stdio') {
      servers[name] = {
        type: 'stdio',
        command: server.command,
        args: server.args.map(arg => substituteEnvVars(arg)),
      };
    }
    // Handle SSE type similarly
  }

  return servers;
}
```

## Environment Variables

```env
# Redis
REDIS_URL=redis://localhost:6379

# Sessions
CLAUDE_SESSIONS_DIR=~/.claude/sessions

# Existing
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://...
```

## File Structure

```
src/
├── index.ts              # Entry point (start worker + gateway)
├── queue/
│   ├── index.ts          # BullMQ queue setup
│   ├── types.ts          # Job type definitions
│   └── worker.ts         # Worker process logic
├── agent/
│   ├── runtime.ts        # SDK query() wrapper
│   ├── permissions.ts    # Tool tier logic + canUseTool
│   └── mcp-loader.ts     # Load MCP config to SDK format
├── slack/
│   ├── gateway.ts        # Slack WebSocket → queue jobs
│   └── responder.ts      # Send messages to Slack
├── db/
│   ├── pool.ts           # PostgreSQL connection
│   └── migrations/
│       └── 004_sessions.sql  # Sessions + approvals tables
└── config/
    ├── mcp-servers.yml   # Existing MCP config
    └── tool-policies.yml # Existing tier config
```

## Testing Strategy

1. **Unit tests:** Permission logic, MCP config loader
2. **Integration tests:** Queue → Worker → SDK flow
3. **E2E tests:** Slack message → session → approval → resume

## Migration Path

1. Install dependencies (BullMQ, update SDK)
2. Create database migrations
3. Build queue infrastructure
4. Build worker with SDK integration
5. Update Slack gateway to use queue
6. Remove old runtime code
7. Update tests