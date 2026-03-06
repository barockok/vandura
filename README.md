# Vandura

<div align="center">
  <img src="https://static.wikia.nocookie.net/readyplayerone/images/c/c6/001-a-team-tribute-van-for-sale-.jpg/revision/latest?cb=20180614112519" alt="The A-Team Van" width="600" />
  <br />
  <em>"I love it when a plan comes together."</em>
</div>

<br />

Slack-based bridge that connects your team to AI agents powered by any MCP (Model Context Protocol) server — with built-in governance, tiered approval workflows, and full audit trails.

Plug in any off-the-shelf or custom MCP server, configure approval policies around it, and your team can interact with it through natural conversation in Slack. Vandura handles the governance layer so you don't build it into every integration.

## How It Works

1. User `@mentions` the agent in a Slack channel
2. Agent creates a thread and works the task using connected MCP tools
3. Every tool call is governed by a three-tier approval system:
   - **Tier 1** — Auto-execute (safe, read-only operations)
   - **Tier 2** — Initiator confirms before execution
   - **Tier 3** — Checker (second person) approves before execution
4. Large results are uploaded to S3-compatible storage with signed URLs
5. Full audit trail logged to Postgres

## Architecture

```
Slack Channel
  └─ @mention → SlackGateway
                  └─ ThreadManager (task per thread)
                       └─ AgentRuntime (Claude API tool-use loop)
                            └─ ToolExecutor
                                 ├─ PermissionService (role-based access)
                                 ├─ ApprovalEngine (tier classification)
                                 └─ MCP tool runners (any MCP server)
```

The key idea: MCP servers handle the integration (database, API, docs, CI/CD, whatever). Vandura wraps them with approval policies, role-based permissions, and audit logging — so your team can use them safely through Slack without building governance into each tool.

### Key Components

| Component | Path | Purpose |
|-----------|------|---------|
| App wiring | `src/app.ts` | Main entry point, connects all services |
| Agent runtime | `src/agent/runtime.ts` | Claude API tool-use loop |
| Tool executor | `src/agent/tool-executor.ts` | Permission + approval middleware |
| Approval engine | `src/approval/engine.ts` | Tier classification, dynamic EXPLAIN-based |
| Permission service | `src/permissions/service.ts` | Role-based tool access control |
| User manager | `src/users/manager.ts` | Slack user → Vandura user mapping |
| Slack gateway | `src/slack/gateway.ts` | Mention, thread, member_joined listeners |
| Onboarding flow | `src/slack/onboarding-flow.ts` | DM-based role selection for new members |
| Postgres tool | `src/tools/postgres.ts` | Built-in SQL tool (example MCP integration) |
| Storage | `src/storage/s3.ts` | S3-compatible uploads with signed URLs |
| Health check | `src/health.ts` | HTTP health endpoint on port 4734 |

## Prerequisites

- Node.js 20+
- Docker (for local Postgres and MinIO)
- Slack App with Socket Mode enabled
- Anthropic API key

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/barockok/vandura.git
cd vandura
npm install
```

### 2. Start local services

```bash
docker compose up -d
```

This starts Postgres 16 and MinIO (S3-compatible storage).

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in your values:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `DATABASE_URL` | Postgres connection string |
| `S3_ENDPOINT` | MinIO/S3 endpoint |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Storage credentials |
| `S3_BUCKET` | Bucket name for result uploads |

### 4. Run

```bash
# Development (watch mode)
npm run dev

# Production
npm run build
npm start
```

## Configuration

### Tool Policies (`config/tool-policies.yml`)

Wrap any MCP tool with approval tiers. Guardrails are plain-text prompts that Claude evaluates naturally — no tool-specific schema required:

```yaml
tool_policies:
  mcp__db__query:
    tier: dynamic         # tier determined at runtime
    guardrails: "Prefer indexed queries. Reject full table scans."
  mcp__jira__create_issue:
    tier: 2               # initiator must confirm
  mcp__k8s__delete_pod:
    tier: 3               # checker must approve
```

### Roles (`config/roles.yml`)

Define role-based access. See `config/roles.example.yml` for reference:

```yaml
roles:
  engineering:
    agents: [atlas, scribe, courier, sentinel]
    tool_tiers:
      db_query: { max_tier: 3 }
      db_write: { max_tier: 3 }
  pm:
    agents: [atlas, scribe]
    tool_tiers:
      db_query: { max_tier: 1 }
      db_write: { max_tier: 0 }   # blocked
```

### Agents (`config/agents.yml`)

Define agent personality and available tools.

## User Onboarding

When a new member joins a channel where Vandura is deployed:

1. Bot sends a DM with available roles
2. User replies with their role (by name or number)
3. User is created in the database and marked as onboarded
4. Role determines which tools and approval tiers are available

## Testing

```bash
# Unit + integration tests
npm test

# Watch mode
npm run test:watch

# E2E tests (requires running Slack app + real tokens)
npm run test:e2e:slack

# Type check
npm run typecheck

# Lint
npm run lint
```

Tests use [Vitest](https://vitest.dev/) with [Testcontainers](https://testcontainers.com/) for integration tests against real Postgres.

## Deployment

Kubernetes manifests are in `k8s/`:

```bash
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/configmap.yml
kubectl apply -f k8s/secrets.example.yml  # create your own secrets.yml
kubectl apply -f k8s/deployment.yml
kubectl apply -f k8s/service.yml
```

The deployment includes health probes on port 4734 (`/healthz`).

## Project Structure

```
src/
  agent/          # Claude API runtime + tool executor
  approval/       # Tier classification engine
  audit/          # Audit logging
  config/         # YAML config loader + Zod schemas
  credentials/    # Credential encryption (envelope encryption)
  db/             # Postgres connection + migrations
  permissions/    # Role-based access control
  slack/          # Gateway, approval flow, checker flow, onboarding
  storage/        # S3-compatible file storage
  threads/        # Task + message management
  tools/          # Tool definitions (PostgresTool)
  users/          # User management
config/           # YAML config files (agents, roles, tool policies)
k8s/              # Kubernetes deployment manifests
tests/            # Unit, integration, and E2E tests
```

## License

ISC
