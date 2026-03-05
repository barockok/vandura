# Squadron — AI Agent Swarm for Slack

## Overview

Squadron is a Slack-integrated AI agent system that gives non-technical team members (PMs, business, ops) access to databases, service endpoints, documentation platforms, and more — through natural conversation. It operates like a "remote Claude Code" triggered via Slack, with built-in governance: tiered autonomy, maker-checker approval workflows, and full audit trails.

Built on the **Anthropic Claude Agent SDK** with **MCP (Model Context Protocol)** servers for integrations. Any off-the-shelf MCP server can be plugged in and wrapped with configurable approval policies.

## Core Principles

- **Transparency** — all interactions happen in channels (private or public), never DMs. Everyone in the channel can see what the agent is doing.
- **Maker-checker governance** — high-risk actions require a second person to approve before execution.
- **MCP-native** — integrations are standard MCP servers. Squadron wraps them with approval logic, not the other way around.
- **Per-user identity** — where applicable, the agent acts on behalf of the user using their own OAuth tokens. Shared resources use admin-managed service accounts.
- **Security-first** — all credentials encrypted at rest with envelope encryption via external KMS.

## Tech Stack

- **Language:** TypeScript
- **Agent SDK:** Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **Slack:** Slack Bolt SDK (Socket Mode — no public URL needed)
- **Database:** PostgreSQL (single data store, no Redis)
- **File Storage:** GCS (result uploads with signed expiry URLs)
- **Encryption:** AES-256-GCM with envelope encryption, master key in external KMS
- **Deployment:** Kubernetes

---

## 1. Conversation Workflow & Thread Model

### Flow

1. User A `@mentions` an agent in a channel where Squadron is deployed
2. Agent creates a **new thread** and replies there:
   - Acknowledges the request
   - Logs what it's about to do (transparency)
   - Asks who should review this, or auto-selects based on action type config
3. User A nominates a checker (User B), or agent auto-selects based on config
4. Agent works the task in the thread:
   - **Tier 1** actions: executes immediately, posts results
   - **Tier 2** actions: posts what it wants to do, asks User A (initiator) to confirm
   - **Tier 3** actions: posts what it wants to do, asks User B (checker) to approve
5. For large results: agent uploads to GCS, posts a signed download link
6. Agent posts a summary and asks if the task is complete
7. User A or B closes the task. Agent posts final summary with audit trail.

### Thread = Task = Agent Instance

- One Claude agent instance per thread (its own conversation history)
- Thread metadata stored in Postgres: initiator, checker, topic, status, tools used
- Agent cannot be invoked via DM — channel only (private or public)
- Multiple threads can run concurrently for different tasks

---

## 2. Tiered Autonomy & Approval

### Tier Classification

| Tier | Criteria | Approval Required | Example |
|------|----------|-------------------|---------|
| **Tier 1** (safe) | Read-only, small scope, pre-approved | Auto-execute | Small indexed DB query, Grafana dashboard read |
| **Tier 2** (caution) | Write operations, unvetted queries, doc creation | Initiator confirms | Create Confluence page, large DB query |
| **Tier 3** (critical) | Destructive operations, bulk mutations, production changes | Checker approves | DB deletes, bulk updates |
| **Dynamic** | Agent evaluates at runtime (e.g., via EXPLAIN) | Determined by evaluation | DB queries — tier depends on cost/scope |

### Checker Determination (Combination Model)

- **Role-based** — certain actions always route to a specific role (e.g., DB writes go to an engineer)
- **Peer-based** — any other channel member can approve, as long as it's not the requester
- Configurable per tool policy

### Tool Policy Configuration

Any MCP tool can be wrapped with approval policies. Guardrails are plain-text prompts — generic and universal, not tool-specific schema fields. Claude evaluates them naturally.

```yaml
tool_policies:
  mcp__db__query:
    tier: "dynamic"
    guardrails: |
      Before executing, run EXPLAIN on the query first.
      If estimated rows > 1000 or a sequential scan is detected,
      escalate to tier 2.
      If the query touches tables in the sensitive list, escalate to tier 3.
      Always show the query and EXPLAIN output in the thread before executing.

  mcp__db__write:
    tier: 3
    guardrails: |
      Show the exact SQL statement and affected table.
      Estimate how many rows will be affected.
      Never allow DROP or TRUNCATE.

  mcp__confluence__create_page:
    tier: 2
    guardrails: |
      Confirm the target space and page title with the initiator.
      Show a preview of the content before creating.

  mcp__gcs__upload:
    tier: 1
    guardrails: null

  _default:
    tier: 2
    guardrails: |
      Describe what this tool will do and what parameters you are passing.
      Ask the initiator to confirm before proceeding.
```

### Approval Middleware Flow

```
Agent wants to call a tool
        |
Approval Middleware:
  1. Look up tool_policies[tool_name] (or _default)
  2. Inject guardrails prompt into agent context
  3. Apply tier logic (static or dynamic)
        |
Tier resolved:
  - Tier 1: execute
  - Tier 2: ask initiator in thread, wait, execute
  - Tier 3: ask checker in thread, wait, execute
        |
Standard MCP server executes (unchanged, unaware of approval)
```

MCP servers are completely decoupled from the approval layer. Add a new community MCP server, drop it in, add a line to tool_policies, done.

---

## 3. Agent Pool & Personas

### Concept

Instead of one generic bot, Squadron provides a **pool of named agents**, each with its own Slack bot handle, personality, and tool set. They are independent workers — one agent handles one task at a time. If an agent is busy, users pick a different one.

### Agent Configuration

```yaml
agents:
  - name: "Atlas"
    avatar: "compass"
    role: "data-analyst"
    personality: "Precise, methodical. Always shows the query plan. Prefers tables over prose."
    tools: [mcp-db, mcp-gcs, mcp-grafana]
    slack_bot_token: xoxb-atlas-...
    max_concurrent_tasks: 1
    system_prompt_extra: |
      You are a data analyst. Present results as tables.
      Upload large results to GCS.

  - name: "Scribe"
    avatar: "memo"
    role: "doc-writer"
    personality: "Clear, structured writer. Asks about audience and format before drafting."
    tools: [mcp-confluence, mcp-gdocs, mcp-gcs]
    slack_bot_token: xoxb-scribe-...
    max_concurrent_tasks: 1
    system_prompt_extra: |
      You create and edit documents. Always confirm the target
      space/folder and audience before writing.

  - name: "Courier"
    avatar: "satellite"
    role: "api-operator"
    personality: "Concise, operational. Reports status codes and response summaries."
    tools: [mcp-rest, mcp-gcs]
    slack_bot_token: xoxb-courier-...
    max_concurrent_tasks: 1
    system_prompt_extra: |
      You interact with REST APIs. Always confirm the endpoint
      and method before executing. Summarize responses clearly.

  - name: "Sentinel"
    avatar: "shield"
    role: "admin"
    personality: "Cautious, security-minded. Double-checks everything."
    tools: [mcp-db, mcp-rest, mcp-confluence, mcp-gdocs, mcp-gcs, mcp-grafana]
    slack_bot_token: xoxb-sentinel-...
    max_concurrent_tasks: 3
    system_prompt_extra: |
      You have broad access. Use it carefully. Always explain
      your reasoning before taking action.
```

### Interaction

- Each agent is a **separate Slack bot user** with its own `@handle`
- Users `@mention` the agent they want: `@atlas how many active users?`
- If an agent is busy, it responds with its status and suggests alternatives
- All agents share the same Squadron backend — the bot token determines which config to load

---

## 4. System Architecture

```
SLACK (any channel Squadron is deployed to)
  |
  v
Squadron Service (K8s)
  |
  +-- Slack Gateway (Bolt SDK, Socket Mode)
  |     Event listener: app_mention, message (in threads)
  |     Routes events to Thread Manager
  |
  +-- Thread Manager
  |     Creates/resumes agent instances per thread
  |     Manages conversation state in Postgres
  |     Tracks initiator, checker, status
  |
  +-- Approval Engine (Middleware)
  |     Intercepts tool calls before execution
  |     Reads tool_policies config
  |     Injects guardrails prompts
  |     Tier classification (static or dynamic)
  |     Posts approval requests to Slack thread
  |     Waits for reaction/reply from correct user
  |     Timeout & escalation rules
  |
  +-- Agent Runtime (Claude Agent SDK)
  |     One logical agent per thread
  |     Connects to MCP servers based on user permissions
  |     System prompt includes: role, allowed tools, guardrails
  |
  +-- Permission & Auth Layer
  |     Slack user to Squadron user mapping
  |     Role definitions (what tools each role can access)
  |     Per-user tool allowlists
  |     Checker routing rules
  |
  +-- Credential Manager
  |     AES-256-GCM encryption / decryption
  |     Envelope encryption via external KMS
  |     Decrypt only in memory, on demand
  |     Token refresh handling
  |
  +-- Audit & Observability
  |     Every tool call logged (who, what, when, approved by)
  |     Task lifecycle events
  |     Searchable (Elasticsearch or Postgres full-text)
  |
  +-- MCP Servers (standard, off-the-shelf or custom)
        mcp-db         (shared connection)
        mcp-confluence  (per-user OAuth)
        mcp-gdocs       (per-user OAuth)
        mcp-gcs         (shared connection)
        mcp-rest        (shared connection)
        mcp-grafana     (shared connection)
```

### Deployment (K8s)

```
squadron-namespace/
  +-- squadron-service (Deployment)
  |     container: squadron-core (Bolt + Agent SDK + Approval Engine)
  +-- mcp-db (Deployment)
  +-- mcp-confluence (Deployment)
  +-- mcp-gdocs (Deployment)
  +-- mcp-gcs (Deployment)
  +-- mcp-rest (Deployment, one per configured API)
  +-- mcp-grafana (Deployment)
  +-- postgres (StatefulSet or managed)
```

---

## 5. Permission & Onboarding

### Onboarding Flow

1. User joins a channel where Squadron is deployed
2. Squadron detects `member_joined_channel` event
3. Agent DMs the user to set up:
   - Role selection (PM, Engineering, Business, Other)
   - Per-user OAuth linking (Google, Confluence, Jira) — agent acts on their behalf
   - Shared resource access requests (databases, Grafana, APIs) — admin approves
4. User confirmed and ready to use agents in the channel

### Connection Types

| Type | Auth Model | Examples |
|------|-----------|----------|
| **Shared** | Service account, admin-managed | Database, Grafana, internal REST APIs, GCS |
| **Per-user** | OAuth per individual | Google Docs, Confluence, Jira |

### Role Default Permissions

```yaml
roles:
  pm:
    agents: [atlas, scribe]
    tool_tiers:
      mcp-db: { max_tier: 1 }
      mcp-confluence: { max_tier: 2 }
      mcp-gdocs: { max_tier: 2 }
      mcp-gcs: { max_tier: 1 }

  engineering:
    agents: [atlas, scribe, courier, sentinel]
    tool_tiers:
      mcp-db: { max_tier: 3 }
      mcp-confluence: { max_tier: 2 }
      mcp-gdocs: { max_tier: 2 }
      mcp-rest: { max_tier: 3 }
      mcp-gcs: { max_tier: 2 }

  business:
    agents: [atlas, scribe]
    tool_tiers:
      mcp-db: { max_tier: 1 }
      mcp-confluence: { max_tier: 1 }
      mcp-gdocs: { max_tier: 2 }
      mcp-gcs: { max_tier: 1 }
```

### Access Rules

- Channel membership = access. Leave channel = access revoked.
- Admins can override role defaults per user.
- Partial onboarding is fine — if a user only connects Google but not Confluence, they can still use Google Docs. Agent tells them when they try to use an unconnected service.

---

## 6. Credential Security

### Encryption Model

- **AES-256-GCM** encryption for all tokens and credentials stored in Postgres
- **Envelope encryption** — KMS encrypts a data encryption key (DEK), DEK encrypts the tokens
- **Master key in external KMS** — HashiCorp Vault, GCP KMS, or K8s Secrets with encryption at rest
- **Decrypt only in memory, on demand** — tokens decrypted only when an MCP server needs them for a tool call
- **No tokens in logs** — audit log records actions and connections, never credentials
- **Token rotation** — OAuth refresh tokens auto-rotate; shared credentials have expiry notifications

### Credential Flow for a Tool Call

1. Approval Engine approves a tool call
2. Credential Manager reads encrypted row from Postgres
3. Unwraps DEK via KMS
4. Decrypts token in memory
5. Checks expiry, refreshes if needed (re-encrypts new token, saves)
6. Passes plaintext token to MCP server via secure in-process handoff
7. MCP server uses token, makes API call
8. Token discarded from memory

---

## 7. GCS Upload & Result Delivery

### When to Upload

Agent uploads to GCS when results exceed a configurable threshold (e.g., >50 rows for DB queries, or any generated file like PDF/CSV).

### Flow

1. Agent gets large results
2. Calls `mcp-gcs.upload` with content, filename, content type, expiry
3. MCP server uploads to `gs://squadron-results/{task_id}/{filename}`
4. Returns signed URL with expiry
5. Agent posts preview (first N rows) + download link in the thread

### Lifecycle

- Signed URLs expire (configurable, default 24h)
- Bucket lifecycle policy auto-deletes objects older than 7 days
- Every upload recorded in audit log

---

## 8. Data Model

```sql
-- Agent definitions
CREATE TABLE agents (
    id                  UUID PRIMARY KEY,
    name                VARCHAR(50) UNIQUE NOT NULL,
    avatar              VARCHAR(10),
    role                VARCHAR(50) NOT NULL,
    personality         TEXT,
    tools               JSONB NOT NULL,
    system_prompt_extra TEXT,
    slack_bot_token_enc BYTEA NOT NULL,
    slack_bot_token_iv  BYTEA NOT NULL,
    slack_bot_token_tag BYTEA NOT NULL,
    dek_enc             BYTEA NOT NULL,
    max_concurrent_tasks INT DEFAULT 1,
    is_active           BOOLEAN DEFAULT true,
    created_at          TIMESTAMPTZ DEFAULT now()
);

-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY,
    slack_id        VARCHAR(50) UNIQUE NOT NULL,
    display_name    VARCHAR(100),
    role            VARCHAR(50) NOT NULL,
    tool_overrides  JSONB DEFAULT '{}',
    is_active       BOOLEAN DEFAULT true,
    onboarded_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Shared connections (admin-managed)
CREATE TABLE shared_connections (
    id              UUID PRIMARY KEY,
    name            VARCHAR(100) UNIQUE NOT NULL,
    provider        VARCHAR(50) NOT NULL,
    credentials_enc BYTEA NOT NULL,
    credentials_iv  BYTEA NOT NULL,
    credentials_tag BYTEA NOT NULL,
    dek_enc         BYTEA NOT NULL,
    config          JSONB,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- User access to shared connections
CREATE TABLE user_shared_access (
    id                   UUID PRIMARY KEY,
    user_id              UUID REFERENCES users(id) ON DELETE CASCADE,
    shared_connection_id UUID REFERENCES shared_connections(id),
    approved_by          VARCHAR(50),
    access_level         VARCHAR(20) DEFAULT 'read',
    granted_at           TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, shared_connection_id)
);

-- Per-user OAuth connections
CREATE TABLE user_connections (
    id                UUID PRIMARY KEY,
    user_id           UUID REFERENCES users(id) ON DELETE CASCADE,
    provider          VARCHAR(50) NOT NULL,
    access_token_enc  BYTEA NOT NULL,
    refresh_token_enc BYTEA,
    token_iv          BYTEA NOT NULL,
    token_tag         BYTEA NOT NULL,
    dek_enc           BYTEA NOT NULL,
    token_expires_at  TIMESTAMPTZ,
    scopes            JSONB,
    connected_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, provider)
);

-- Tasks (one per Slack thread)
CREATE TABLE tasks (
    id                  UUID PRIMARY KEY,
    slack_thread_ts     VARCHAR(50) NOT NULL,
    slack_channel       VARCHAR(50) NOT NULL,
    agent_id            UUID REFERENCES agents(id),
    initiator_slack_id  VARCHAR(50) NOT NULL,
    checker_slack_id    VARCHAR(50),
    topic               TEXT,
    status              VARCHAR(20) DEFAULT 'open',
    created_at          TIMESTAMPTZ DEFAULT now(),
    closed_at           TIMESTAMPTZ
);

-- Conversation history
CREATE TABLE messages (
    id          UUID PRIMARY KEY,
    task_id     UUID REFERENCES tasks(id),
    role        VARCHAR(20) NOT NULL,
    content     TEXT NOT NULL,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Approval requests
CREATE TABLE approvals (
    id              UUID PRIMARY KEY,
    task_id         UUID REFERENCES tasks(id),
    tool_name       VARCHAR(100) NOT NULL,
    tool_input      JSONB NOT NULL,
    tier            SMALLINT NOT NULL,
    requested_by    VARCHAR(50) NOT NULL,
    approved_by     VARCHAR(50),
    status          VARCHAR(20) DEFAULT 'pending',
    guardrail_output TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

-- Audit log (immutable)
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY,
    task_id     UUID REFERENCES tasks(id),
    agent_id    UUID REFERENCES agents(id),
    action      VARCHAR(50) NOT NULL,
    actor       VARCHAR(50) NOT NULL,
    detail      JSONB NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);
```

---

## 9. Build vs. Buy Summary

| Component | Approach |
|---|---|
| Agent orchestrator + Slack interface | Build (Claude Agent SDK + Slack Bolt) |
| Maker-checker approval engine | Build (core IP) |
| Tool policy config + guardrails | Build |
| Permission/auth layer | Build |
| Credential Manager | Build (with KMS integration) |
| MCP servers (DB, Confluence, GDocs, GCS, REST, Grafana) | Use existing community MCP servers where available, build thin wrappers where needed |
| Audit logging | Build |

Reference: [claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot) as a starting point for the Slack + Agent SDK integration pattern.

---

## 10. Key References

- [Anthropic Claude Agent SDK (TypeScript)](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK MCP Docs](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [Slack Bolt SDK](https://slack.dev/bolt-js/)
- [Slack MCP Server](https://docs.slack.dev/ai/slack-mcp-server/)
- [claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot)
- [Composio MCP Integrations](https://mcp.composio.dev/)
- [Runlayer (MCP security)](https://www.runlayer.com/)
