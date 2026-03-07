# Vandura — AI Agent Swarm for Slack

## Overview

Vandura is a Slack-integrated AI agent system that gives non-technical team members (PMs, business, ops) access to databases, service endpoints, documentation platforms, and more — through natural conversation. It operates like a "remote Claude Code" triggered via Slack, with built-in governance: tiered autonomy, maker-checker approval workflows, and full audit trails.

Built on the **Anthropic Claude Agent SDK** with **MCP (Model Context Protocol)** servers for integrations. Any off-the-shelf MCP server can be plugged in and wrapped with configurable approval policies.

## Implementation Status (as of 2026-03-06 19:50 UTC+7)

| § | Section | Status | Notes |
|---|---------|--------|-------|
| 1 | Conversation & Thread Model | **Done** | Thread per task, initiator/checker, task close with summary + token usage |
| 2 | Tiered Autonomy & Approval | **Done** | Tier 1/2/3 classification, tool policies with guardrails, per-task approval reuse (approve once, follow-up actions auto-execute) |
| 3 | Agent Pool & Personas | **Partial** | Single agent working end-to-end. Multi-agent with separate bot tokens per persona not yet implemented |
| 4 | System Architecture | **Done** | All core components wired: gateway, thread manager, approval engine, agent runtime, tool executor, permission service |
| 5 | Permission & Onboarding | **Done** | Role-based permissions, DM onboarding flow, tool overrides. Shared tools (e.g. database) don't gate on onboarding |
| 6 | Credential Security | **Partial** | Local KMS + credential manager implemented. Per-user OAuth (Confluence, Google) and external KMS (GCP, Vault) not yet wired |
| 7 | GCS/S3 Upload & Results | **Done** | S3-compatible storage (MinIO for dev, S3/GCS for prod), signed URLs, large response upload, file export tool |
| 8 | Data Model | **Done** | All tables created, migration versioning fixed, token usage columns added |
| 9 | Testing & CI/CD | **Partial** | 138 unit/integration tests across 24 files, GitHub Actions CI (lint + typecheck + tests). E2E docker-compose and Slack test harness not yet built |
| 10 | Deployment Guide | **Completed** | Migration job manifest, pre-deploy script, complete README with env reference, troubleshooting, upgrade/rollback procedures, Slack app creation guide |
| 11 | Thread Persistence & Lifecycle | **Not started** | Design documented. Thread reconnection, auto-stale, memory eviction all pending |
| 12 | Swarm Architecture | **Not started** | Multi-agent collaboration, scheduler, task-as-plan with phased approvals |
| 13 | Enhanced Onboarding | **Not started** | Permission-aware onboarding, multiple agent role types |
| 14 | MCP Connection Management | **Not started** | Shared vs per-user connections, OAuth maintenance, chat-based config |
| 15 | Management & Governance | **Not started** | Token limits, channel-specific deploy, scheduled tasks, memory management |
| 16 | Build vs Buy | **N/A** | Reference section |

### Additional improvements shipped (not in original design)
- Slack-native formatting (slackify-markdown + prompt-level formatting instructions)
- Natural conversational tone in agent responses
- Task clarification flow (agent asks questions before acting on vague requests)
- Token usage tracking per task (input/output tokens stored in DB, shown in task summary)
- Deferred checker nomination (only asks for checker when tier-3 action is actually needed)
- Graceful shutdown with force timeout
- Duplicate mention deduplication
- Current date injection in system prompt
- Sample NovaCRM database for testing

---

## Core Principles

- **Transparency** — all interactions happen in channels (private or public), never DMs. Everyone in the channel can see what the agent is doing.
- **Maker-checker governance** — high-risk actions require a second person to approve before execution.
- **MCP-native** — integrations are standard MCP servers. Vandura wraps them with approval logic, not the other way around.
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

1. User A `@mentions` an agent in a channel where Vandura is deployed
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

Instead of one generic bot, Vandura provides a **pool of named agents**, each with its own Slack bot handle, personality, and tool set. They are independent workers — one agent handles one task at a time. If an agent is busy, users pick a different one.

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
- All agents share the same Vandura backend — the bot token determines which config to load

---

## 4. System Architecture

```
SLACK (any channel Vandura is deployed to)
  |
  v
Vandura Service (K8s)
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
  |     Slack user to Vandura user mapping
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
vandura-namespace/
  +-- vandura-service (Deployment)
  |     container: vandura-core (Bolt + Agent SDK + Approval Engine)
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

1. User joins a channel where Vandura is deployed
2. Vandura detects `member_joined_channel` event
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
3. MCP server uploads to `gs://vandura-results/{task_id}/{filename}`
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

## 9. Testing Infrastructure & CI/CD

### Philosophy

Every feature must be verifiable end-to-end without external dependencies. Tests run the same way locally and in CI. No "works on my machine."

### Test Layers

| Layer | What | Tools | Runs |
|-------|------|-------|------|
| **Unit** | Pure logic: tier classification, config parsing, credential encryption/decryption, permission checks | Vitest | Every commit |
| **Integration** | Component interactions: approval engine + Postgres, thread manager + Postgres, credential manager + KMS mock | Vitest + Testcontainers (Postgres) | Every commit |
| **MCP Server** | Each MCP server tested against real backing services | Vitest + Testcontainers (Postgres, mock HTTP servers) | Every commit |
| **End-to-End** | Full conversation flow: Slack event in, agent processes, tool calls, approval flow, Slack messages out | Docker Compose (full stack) + Slack test harness | PR merge, release |
| **Smoke** | Post-deploy verification against real environment | Lightweight script hitting health endpoints + one known query | Post-deploy |

### Testcontainers Setup

Integration and MCP server tests spin up real dependencies via Testcontainers — no mocks for data stores:

```typescript
// tests/setup/containers.ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";

let pgContainer: StartedPostgreSqlContainer;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vandura_test")
    .start();

  // Run migrations against the test DB
  await runMigrations(pgContainer.getConnectionUri());
}, 60_000);

afterAll(async () => {
  await pgContainer.stop();
});
```

Each test suite gets a fresh database. Tests are isolated — no shared state between suites.

### Docker Compose for E2E

A `docker-compose.test.yml` brings up the entire stack for end-to-end testing:

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: vandura_test
      POSTGRES_USER: vandura
      POSTGRES_PASSWORD: test
    ports:
      - "5433:5432"

  vandura:
    build:
      context: .
      dockerfile: Dockerfile
      target: test
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://vandura:test@postgres:5432/vandura_test
      KMS_PROVIDER: local          # local file-based KMS for testing
      SLACK_MODE: test_harness     # intercepts Slack API calls
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    volumes:
      - ./test-config:/app/config  # test tool policies, agent configs

  slack-harness:
    build:
      context: ./tests/slack-harness
    depends_on:
      - vandura
    environment:
      SQUADRON_URL: http://vandura:3000
    ports:
      - "3001:3001"               # test API to simulate Slack events
```

### Slack Test Harness

A lightweight service that simulates Slack's event API and captures outgoing messages:

- Sends `app_mention` events to Vandura
- Captures thread replies, approval request messages
- Simulates user reactions/replies for approval flows
- Asserts message content, ordering, and thread structure

### What Gets Tested E2E

1. **Happy path**: User mentions agent -> thread created -> tier 1 query -> result posted
2. **Tier 2 approval**: User requests doc creation -> agent asks for confirmation -> user confirms -> doc created
3. **Tier 3 maker-checker**: User requests DB write -> agent asks checker -> checker approves -> write executed
4. **Tier 3 rejection**: Checker denies -> agent reports denial, no execution
5. **Approval timeout**: No response within timeout -> agent reports timeout
6. **Busy agent**: Agent at max concurrent tasks -> responds with status + alternatives
7. **Permission denied**: User without access to a shared connection -> agent reports missing access
8. **Credential flow**: OAuth token refresh during tool call -> new token encrypted and saved
9. **GCS upload**: Large result set -> uploaded to GCS -> signed URL posted in thread
10. **Onboarding**: User joins channel -> DM sent -> role selected -> permissions granted

### GitHub Actions CI/CD

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck

  unit-and-integration:
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test -- --reporter=junit --outputFile=test-results.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: test-results.xml

  e2e:
    runs-on: ubuntu-latest
    needs: unit-and-integration
    steps:
      - uses: actions/checkout@v4
      - run: docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - run: docker compose -f docker-compose.test.yml down -v

  build-and-push:
    runs-on: ubuntu-latest
    needs: e2e
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:latest
            ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Release Pipeline

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}:latest
      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

### Docker Image

Multi-stage Dockerfile:

```dockerfile
# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Test stage (used by docker-compose.test.yml)
FROM build AS test
RUN npm ci --include=dev
CMD ["npm", "test"]

# Production stage
FROM node:22-alpine AS production
WORKDIR /app
RUN addgroup -S vandura && adduser -S vandura -G vandura
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
USER vandura
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

---

## 10. Deployment & Installation Guide

### Prerequisites

- Kubernetes cluster (1.28+)
- PostgreSQL 16+ (managed or self-hosted)
- GCS bucket (for result uploads)
- KMS access (GCP KMS, HashiCorp Vault, or K8s Secrets with encryption at rest)
- Slack workspace with admin access to create apps
- Anthropic API key

### Step 1: Create Slack Apps

Each agent needs its own Slack app. For each agent (e.g., Atlas, Scribe, Sentinel):

1. Go to https://api.slack.com/apps and click "Create New App"
2. Name it after the agent (e.g., "Atlas")
3. Enable **Socket Mode** (Settings > Socket Mode > Enable)
4. Add **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:write`, `channels:read`, `groups:read`, `users:read`
5. Subscribe to **Events**: `app_mention`, `message.channels`, `message.groups`, `member_joined_channel`
6. Install to workspace and note the **Bot Token** (`xoxb-...`) and **App-Level Token** (`xapp-...`)
7. Set a custom avatar and display name matching the agent persona

### Step 2: Provision Infrastructure

```bash
# Clone the repository
git clone https://github.com/your-org/vandura.git
cd vandura

# Copy example config
cp config/vandura.example.yml config/vandura.yml
cp config/tool-policies.example.yml config/tool-policies.yml
cp config/agents.example.yml config/agents.yml
```

#### PostgreSQL

```bash
# If using managed Postgres, note the connection string.
# If self-hosted on K8s:
kubectl create namespace vandura
kubectl apply -f k8s/postgres-statefulset.yml
```

#### GCS Bucket

```bash
# Create the results bucket
gsutil mb -l US gs://your-org-vandura-results

# Set lifecycle policy (auto-delete after 7 days)
gsutil lifecycle set k8s/gcs-lifecycle.json gs://your-org-vandura-results

# Create a service account for GCS access
gcloud iam service-accounts create vandura-gcs \
  --display-name="Vandura GCS Service Account"
gcloud storage buckets add-iam-policy-binding gs://your-org-vandura-results \
  --member="serviceAccount:vandura-gcs@your-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

### Step 3: Configure Secrets

```bash
# Create K8s secrets
kubectl -n vandura create secret generic vandura-secrets \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --from-literal=DATABASE_URL=postgres://user:pass@host:5432/vandura \
  --from-literal=GCS_SERVICE_ACCOUNT_KEY="$(cat gcs-sa-key.json)" \
  --from-literal=KMS_KEY_URI=gcp-kms://projects/your-project/locations/global/keyRings/vandura/cryptoKeys/master

# Create per-agent secrets (bot tokens)
kubectl -n vandura create secret generic agent-tokens \
  --from-literal=ATLAS_BOT_TOKEN=xoxb-... \
  --from-literal=ATLAS_APP_TOKEN=xapp-... \
  --from-literal=SCRIBE_BOT_TOKEN=xoxb-... \
  --from-literal=SCRIBE_APP_TOKEN=xapp-... \
  --from-literal=SENTINEL_BOT_TOKEN=xoxb-... \
  --from-literal=SENTINEL_APP_TOKEN=xapp-...
```

### Step 4: Configure Vandura

Edit `config/vandura.yml`:

```yaml
# config/vandura.yml
database:
  url: ${DATABASE_URL}
  pool_size: 20

gcs:
  bucket: your-org-vandura-results
  default_expiry: 24h
  max_expiry: 168h  # 7 days

kms:
  provider: gcp-kms   # or: vault, local
  key_uri: ${KMS_KEY_URI}

slack:
  mode: socket         # socket mode, no public URL needed
  channels:            # channels where Vandura is active
    - C0123ABCDEF      # #ops-agent
    - C0456GHIJKL      # #data-team

onboarding:
  enabled: true
  default_role: business
  available_roles: [pm, engineering, business]

oauth:
  google:
    client_id: ${GOOGLE_CLIENT_ID}
    client_secret: ${GOOGLE_CLIENT_SECRET}
    redirect_uri: https://vandura.your-org.com/oauth/google/callback
    scopes:
      - https://www.googleapis.com/auth/documents
      - https://www.googleapis.com/auth/drive.file
  confluence:
    client_id: ${CONFLUENCE_CLIENT_ID}
    client_secret: ${CONFLUENCE_CLIENT_SECRET}
    redirect_uri: https://vandura.your-org.com/oauth/confluence/callback
    scopes:
      - read:confluence-content.all
      - write:confluence-content
```

Edit `config/agents.yml` with your agent personas (see Section 3 of this doc).

Edit `config/tool-policies.yml` with your approval tiers and guardrails (see Section 2 of this doc).

### Step 5: Run Database Migrations

```bash
# Locally (for verification)
npm run db:migrate -- --database-url=$DATABASE_URL

# Or via K8s job
kubectl -n vandura apply -f k8s/migration-job.yml
kubectl -n vandura wait --for=condition=complete job/vandura-migrate --timeout=60s
```

### Step 6: Deploy to Kubernetes

```bash
# Apply the deployment manifests
kubectl -n vandura apply -f k8s/deployment.yml
kubectl -n vandura apply -f k8s/service.yml

# Verify pods are running
kubectl -n vandura get pods -w

# Check logs
kubectl -n vandura logs -f deployment/vandura-service
```

### Step 7: Verify Installation

```bash
# Health check
kubectl -n vandura port-forward svc/vandura-service 3000:3000
curl http://localhost:3000/health

# Expected response:
# {
#   "status": "ok",
#   "agents": { "atlas": "connected", "scribe": "connected", "sentinel": "connected" },
#   "database": "connected",
#   "gcs": "connected"
# }
```

Then go to the configured Slack channel and `@mention` any agent. It should respond in a thread.

### Step 8: Add Agents to Channels

Invite each agent bot to the channels where Vandura should operate:

```
/invite @atlas
/invite @scribe
/invite @sentinel
```

### Upgrading

```bash
# Pull latest image
kubectl -n vandura set image deployment/vandura-service \
  vandura-core=ghcr.io/your-org/vandura:v1.2.0

# Run any new migrations
kubectl -n vandura apply -f k8s/migration-job.yml

# Verify
kubectl -n vandura rollout status deployment/vandura-service
```

### Troubleshooting

| Symptom | Check |
|---------|-------|
| Agent not responding to mentions | Verify bot is in the channel, check Socket Mode connection in logs |
| "Permission denied" on tool use | Check user role + tool_overrides in users table |
| Approval request never resolves | Check checker_slack_id is set on the task, verify checker is in channel |
| OAuth callback fails | Verify redirect_uri matches Slack/Google/Confluence app config |
| Credential decryption fails | Verify KMS key URI and service account permissions |
| GCS upload fails | Verify service account has objectAdmin on the bucket |

---

## 11. Thread Persistence & Task Lifecycle (Future Phase)

### Problem

Agent runtime state (conversation history, tool executor, approval tracking) is currently held in memory. If the service restarts, all active threads become unresponsive — the bot won't reply to follow-up messages in existing threads.

Tasks also have no timeout — an "open" task stays open forever in the DB if nobody explicitly closes it, and in-memory maps grow unbounded.

### Requirements

#### Thread Reconnection

When a thread reply comes in for a task that exists in the DB but has no in-memory runtime:

1. Look up the task by `(channel, thread_ts)`
2. Load conversation history from the `messages` table
3. Spin up a new `AgentRuntime` and replay the history
4. Restore the `ToolExecutor` with the task's approved tier level
5. Resume the conversation as if nothing happened

This makes threads survive restarts and feel persistent to users.

#### Task Staleness & Cleanup

- **Auto-stale**: Mark tasks as `stale` after N hours of inactivity (configurable, default 4h)
- **Auto-close**: Close stale tasks after another N hours (configurable, default 24h)
- **Memory eviction**: Evict idle in-memory runtimes after a timeout to bound memory usage
- **Stale notification**: When a task goes stale, post a message in the thread asking if the user still needs it

#### Data Model Changes

```sql
ALTER TABLE tasks
  ADD COLUMN last_activity_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN approved_tier SMALLINT DEFAULT 0;
```

- `last_activity_at` updated on every message or tool call — used for staleness detection
- `approved_tier` persisted so reconnected executors know what's already been approved

#### Implementation Notes

- A periodic cleanup job (setInterval or cron) scans for stale tasks
- Reconnection should be transparent — the user just keeps talking in the thread
- History replay must handle the case where the conversation is very long (truncate oldest messages to fit context window)
- Pending approvals should also be restorable from the `approvals` table

---

## 12. Swarm Architecture (Future Phase)

### Multi-Agent Collaboration

Instead of one agent per task, Vandura evolves into a swarm where multiple specialized agents collaborate on complex tasks.

#### Agent Roles & Specialization

Each agent has a specific role (data analyst, doc writer, API operator, etc.). When a task spans multiple domains, agents hand off sub-tasks to each other:

- User asks Atlas (data analyst) for a quarterly report
- Atlas queries the database, then delegates the write-up to Scribe (doc writer)
- Scribe creates the Confluence page, loops back to Atlas for verification

#### Scheduler

A scheduler component manages agent availability and task routing:

- Tracks which agents are busy vs available
- Routes incoming requests to the best-fit agent based on role and tools
- Manages a **task queue** — when all agents are busy, tells the user they're in queue with an estimated wait time, then spawns the task when an agent becomes available

#### Task as Plan

Complex tasks are treated as plans rather than single actions:

- **Auto-detect complexity**: Determine whether a request is a quick one-shot task or a long-running plan that needs breakdown
- **Plan breakdown**: For complex tasks, break into sub-steps with a plan that gets approval from the manager/initiator before execution
- **Series of approvals**: Long-running plans may need approval at each phase, not just once upfront

---

## 13. Enhanced Onboarding (Future Phase)

### Permission-Aware Onboarding

The onboarding flow should be more than just role selection — it should explicitly ask about permissions and tool access:

1. User joins channel → DM onboarding starts
2. Ask what role they have (PM, Engineering, Business)
3. Ask what tools they need access to (which MCP servers)
4. Ask what permissions they need (read-only vs read-write on specific resources)
5. For per-user OAuth tools, guide them through the connection flow
6. Confirm setup and notify channel admins if elevated access was requested

### Multiple AI Agent Role Types

Different agent types serve different purposes beyond just tool specialization:

- **Worker agents** — execute tasks (current model)
- **Supervisor agents** — review and approve worker output before delivery
- **Scheduler agents** — manage task queues and routing

---

## 14. MCP Connection Management (Future Phase)

### Shared vs Per-User MCP Connections

| Type | Examples | Auth | Guardrails |
|------|----------|------|------------|
| **Shared** | Database, Grafana, Elastic Search | Service account, admin-managed | Be conservative, no full scans, pipe large results to GCS, beware of token usage |
| **Per-user** | Confluence, Google Docs, Jira | OAuth per individual | User-scoped, token refresh needed |

### Guardrails for Shared Resources

Shared MCP connections need stricter guardrails since they use a single service account:

- **Be conservative** — prefer smaller scopes, limit result sets
- **No full scans** — enforce indexed queries, reject sequential scans on large tables
- **Pipe to GCS for results** — large result sets should always be uploaded, not streamed inline
- **Beware of token usage** — shared connections consume from a shared budget

### OAuth Maintenance Challenge

Per-user OAuth connections have a lifecycle problem:

- Tokens expire if the user doesn't interact for a long time
- Refresh tokens may also expire with some providers
- Need a strategy for re-prompting users to reconnect when tokens go stale
- Consider a health check that periodically validates OAuth tokens and notifies users of expiring connections

### Chat-Based MCP Configuration

Admins should be able to add new MCP servers or define guardrails via chat:

- `@sentinel add mcp-server elasticsearch --endpoint=https://...`
- `@sentinel set guardrail db_query "no full table scans on tables > 1M rows"`
- Output is a config file (YAML) that can be reviewed and applied to update the deployment manually
- This keeps the config-as-code approach while allowing conversational setup

---

## 15. Management & Governance (Future Phase)

### Token Usage Management

- **Token usage monitor** — integrate with Grafana for dashboards showing usage per user, per agent, per task
- **Token limits per user** — configurable limits with time frame (e.g., 100k tokens/day) or cooldown period after hitting the limit
- **Budget alerts** — notify admins when usage approaches thresholds

### Channel-Specific Deployment

- Each channel can have its own set of agents and tool policies
- **Real user supervisor per channel** — a designated person who oversees agent activity in that channel
- Different channels can have different approval requirements and guardrails

### Audit Governance

- **Message deletion handling** — if a user deletes a Slack message, the task and audit trail must remain intact in the database. The audit log is immutable regardless of Slack state.
- **Task and audit governance** — all actions are logged and cannot be retroactively altered

### Scheduled Tasks

- Users can schedule recurring tasks: `@atlas run this query every Monday at 9am`
- Scheduled tasks follow the same approval flow on first setup, then auto-execute on schedule
- Results posted to the configured channel thread

### Memory Management

- **Long-term memory compression** — regularly compress conversation history to stay within context windows
- For long-running tasks, periodically summarize earlier conversation turns and replace verbose history with compressed summaries
- Preserves key decisions and context while keeping token usage bounded

---

## 16. Build vs Buy Summary

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

## 17. Key References

- [Anthropic Claude Agent SDK (TypeScript)](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Claude Agent SDK MCP Docs](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [Slack Bolt SDK](https://slack.dev/bolt-js/)
- [Slack MCP Server](https://docs.slack.dev/ai/slack-mcp-server/)
- [claude-code-slack-bot](https://github.com/mpociot/claude-code-slack-bot)
- [Composio MCP Integrations](https://mcp.composio.dev/)
- [Runlayer (MCP security)](https://www.runlayer.com/)
