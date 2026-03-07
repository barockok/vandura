# Vandura

<div align="center">
  <img src="./aseets/vandura-gmc-a-team-full-crew-pixelate.png" alt="The A-Team Van"  />
  <br />
  <em>"I love it when a plan comes together."</em>
</div>

[![CI](https://github.com/barockok/vandura/actions/workflows/ci.yml/badge.svg)](https://github.com/barockok/vandura/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-47.24%25-yellow)](https://github.com/barockok/vandura#testing)

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

### MCP Servers (`config/mcp-servers.yml`)

Configure MCP server connections and tool mappings. Vandura connects to these servers at startup and discovers available tools:

```yaml
servers:
  postgres:
    name: "PostgreSQL"
    type: "stdio"
    command: "npx"
    args:
      - "-y"
      - "@modelcontextprotocol/server-postgres"
      - "${DATABASE_URL}"
    tools:
      - name: "query"
        mapped_name: "db_query"
        tier: 1
        guardrails: "Prefer indexed queries. Avoid full table scans."
      - name: "execute"
        mapped_name: "db_write"
        tier: 3
        guardrails: "Show exact SQL and affected rows."
```

Supported transport types:
- `stdio` — Run MCP server as a child process (e.g., via npx)
- `sse` — Connect to remote MCP server via Server-Sent Events
- `websocket` — Connect via WebSocket

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

### Troubleshooting

#### Pod won't start

```bash
# Check pod status
kubectl describe pod -n vandura -l app=vandura

# Check logs
kubectl logs -n vandura -l app=vandura --tail=100

# Check for image pull errors
kubectl get pods -n vandura
```

#### Common issues

**Connection refused to database:**
- Verify `DATABASE_URL` and `DB_TOOL_CONNECTION_URL` secrets are correct
- Ensure network policies allow pod-to-database connectivity
- Check database is accessible from cluster CIDR

**Slack Socket Mode connection failed:**
- Verify `SLACK_APP_TOKEN` starts with `xapp-`
- Verify `SLACK_BOT_TOKEN` starts with `xoxb-`
- Ensure Slack app has Socket Mode enabled in app settings

**S3 upload failures:**
- Verify `S3_ENDPOINT` is reachable from cluster
- Check `S3_ACCESS_KEY` and `S3_SECRET_KEY` are correct
- Ensure bucket exists and credentials have write permission

**Health check failing:**
- Check `/health` endpoint: `kubectl port-forward svc/vandura 4734:4734 -n vandura`
- Curl `http://localhost:4734/health`

#### Useful commands

```bash
# Watch pod status
kubectl get pods -n vandura -w

# Exec into running container
kubectl exec -it -n vandura deployment/vandura -- /bin/sh

# Check resource usage
kubectl top pods -n vandura

# View all events in namespace
kubectl get events -n vandura --sort-by='.lastTimestamp'
```

### Per-Agent Slack App Creation

Vandura supports multiple agent personas, each requiring its own Slack app:

1. **Create a new Slack App:**
   - Go to https://api.slack.com/apps
   - Click "Create New App" → "From scratch"
   - App name: e.g., "Atlas" (or your agent name)
   - Pick your development Slack workspace

2. **Enable Socket Mode:**
   - Go to "Socket Mode" in sidebar
   - Enable Socket Mode
   - Generate app-level token (`xapp-...`)
   - Save to `.env` as `SLACK_APP_TOKEN`

3. **Add Bot User:**
   - Go to "OAuth & Permissions"
   - Scroll to "Bot Users"
   - Add username: e.g., `@atlas`
   - Enable "Always Show My Bot as Online"

4. **Configure Event Subscriptions:**
   - Go to "Event Subscriptions"
   - Enable events
   - Under "Subscribe to bot events":
     - Add: `app_mention`
     - Add: `message.channels`
   - Under "Subscribe to events happening in public channels":
     - Add: `member_joined_channel`

5. **Install to Workspace:**
   - Go to "Install App"
   - Click "Install to Workspace"
   - Authorize
   - Copy bot token (`xoxb-...`) to `.env` as `SLACK_BOT_TOKEN`

6. **Update agent configuration:**
   - Add agent to `config/agents.yml` with unique name
   - Map bot token to agent in startup script or environment

7. **Repeat for each agent persona**

Each agent runs as a separate process with its own tokens but shares the same codebase and database.

### Production Deployment Checklist

Before deploying to production, verify:

**Security:**
- [ ] Secrets stored in Kubernetes Secrets (not in git)
- [ ] Database credentials rotated and unique to this environment
- [ ] S3 credentials use least-privilege IAM (not root keys)
- [ ] KMS provider configured for production (not `local`)
- [ ] Network policies restrict pod-to-pod communication

**Reliability:**
- [ ] Resource limits set appropriately for expected load
- [ ] Liveness and readiness probes configured and tested
- [ ] Pod disruption budget configured for HA deployments
- [ ] Database backups configured and tested
- [ ] Monitoring/alerting configured (CPU, memory, error rate)

**Slack Integration:**
- [ ] Slack app installed to production workspace
- [ ] Bot added to relevant channels
- [ ] Event subscriptions verified (app_mention, message.channels, member_joined_channel)
- [ ] Token rotation procedure documented

**Database:**
- [ ] Migrations tested in staging environment
- [ ] Database connection pooling tuned for production
- [ ] Indexes created for frequently queried columns

**Observability:**
- [ ] Health endpoint accessible from load balancer
- [ ] Log aggregation configured (stdout/stderr captured)
- [ ] Token usage metrics tracked per user/agent
- [ ] Audit logs retained per compliance requirements

**Rollback:**
- [ ] Previous stable image tagged and available
- [ ] Rollback procedure tested
- [ ] Database migration rollback script available (if applicable)

---

When a new member joins a channel where Vandura is deployed:

1. Bot sends a DM with available roles
2. User replies with their role (by name or number)
3. User is created in the database and marked as onboarded
4. Role determines which tools and approval tiers are available

## MCP Connection Management

Vandura supports two types of MCP connections:

### Shared Connections

Shared connections use a service account managed by the team. These include:
- **Database** (`db_query`, `db_write`)
- **GCS/MinIO** (`mcp__gcs__*`)
- **Grafana** (`mcp__grafana__*`)
- **Elasticsearch** (`mcp__elastic__*`)

**Guardrails for shared connections:**
- Be conservative: prefer smaller scopes, limit result sets
- Avoid full table scans on large tables (use indexed queries)
- For large results (>1000 rows), upload to GCS instead of inline display
- Watch token usage — shared budget

### Per-User Connections

Per-user connections use OAuth tokens from individual users:
- **Confluence** (`mcp__confluence__*`)
- **Google Docs** (`mcp__gdocs__*`)
- **Jira** (`mcp__jira__*`)

**Characteristics:**
- Actions are scoped to what that user can access
- Tokens may expire; agent will attempt automatic refresh
- If refresh fails, user will be notified to reconnect

### Chat-Based Configuration

Admins can configure MCP servers via chat commands using `@sentinel`:

```
@sentinel Use mcp_config to add_server with server_name=elastic, provider=elasticsearch, endpoint=https://es.example.com, connection_type=shared
```

```
@sentinel Use mcp_config to set_guardrail with tool_name=db_query, guardrail="No full table scans on tables over 1M rows"
```

The agent will generate YAML configuration for manual review and application (config-as-code approach).

### Health Monitoring

The `/health` endpoint includes OAuth token status:

```json
{
  "status": "ok",
  "database": "connected",
  "storage": "connected",
  "oauth": {
    "total": 15,
    "valid": 12,
    "expiring": 2,
    "expired": 1
  }
}
```

**Token statuses:**
- `valid`: Token is active and working
- `expiring`: Token expires within 24 hours (warning)
- `expired`: Token has expired (requires re-authentication)
- `error`: Last refresh attempt failed

---

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

### Prerequisites

- Kubernetes cluster (v1.25+)
- kubectl configured with cluster access
- Docker image built and pushed to registry
- Database (Postgres 16+) accessible from cluster
- S3-compatible storage (GCS, MinIO, AWS S3)

### Quick Deploy

```bash
# 1. Create namespace and apply manifests
kubectl apply -f k8s/namespace.yml

# 2. Create secrets (edit values first)
cp k8s/secrets.example.yml k8s/secrets.yml
# Edit k8s/secrets.yml with your values
kubectl apply -f k8s/secrets.yml

# 3. Apply config map (optional - customize settings)
kubectl apply -f k8s/configmap.yml

# 4. Run database migrations
./k8s/pre-deploy.sh

# 5. Deploy application
kubectl apply -f k8s/deployment.yml
kubectl apply -f k8s/service.yml

# 6. Verify deployment
kubectl get pods -n vandura
kubectl logs -n vandura -l app=vandura
```

### Environment Variables

#### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | `sk-ant-api03-...` |
| `ANTHROPIC_MODEL` | Claude model to use | `claude-sonnet-4-5-20250929` or `claude-3-5-sonnet-20241022` |
| `ANTHROPIC_BASE_URL` | Custom Anthropic API endpoint (for proxies) | `https://api.anthropic.com` (default) |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token | `xoxb-...` |
| `SLACK_APP_TOKEN` | Slack app-level token (Socket Mode) | `xapp-...` |
| `DATABASE_URL` | PostgreSQL connection string for app data | `postgres://user:pass@host:5432/vandura` |
| `DB_TOOL_CONNECTION_URL` | PostgreSQL connection for db_query/db_write tools | `postgres://user:pass@host:5432/target_db` |
| `S3_ENDPOINT` | S3-compatible storage endpoint | `https://storage.googleapis.com` or `http://minio:9000` |
| `S3_ACCESS_KEY` | S3 access key | `minioadmin` or GCS HMAC key |
| `S3_SECRET_KEY` | S3 secret key | Secret value |

#### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_BASE_URL` | Custom Anthropic API endpoint (for proxies) | `https://api.anthropic.com` |
| `S3_REGION` | S3 bucket region | `us-east-1` |
| `S3_BUCKET` | Bucket name for result uploads | `vandura-results` |
| `S3_SIGNED_URL_EXPIRY` | Signed URL expiry in seconds | `86400` (24h) |
| `KMS_PROVIDER` | Key management provider | `local` |
| `SLACK_CHANNEL_ID` | Default channel for E2E tests | - |
| `E2E_INITIATOR_TOKEN` | Slack user token for E2E initiator | `xoxb-...` |
| `E2E_CHECKER_TOKEN` | Slack user token for E2E checker | `xoxb-...` |

### Upgrade Procedure

1. **Backup database** (optional but recommended):
   ```bash
   kubectl exec -n vandura <postgres-pod> -- pg_dump vandura > backup.sql
   ```

2. **Pull latest image**:
   ```bash
   kubectl set image deployment/vandura vandura=ghcr.io/barockok/vandura:latest -n vandura
   ```

3. **Run migrations**:
   ```bash
   ./k8s/pre-deploy.sh
   ```

4. **Rollout deployment**:
   ```bash
   kubectl rollout restart deployment/vandura -n vandura
   ```

5. **Verify rollout**:
   ```bash
   kubectl rollout status deployment/vandura -n vandura
   ```

6. **Check health**:
   ```bash
   kubectl get pods -n vandura
   curl http://<service-ip>:4734/health
   ```

### Rollback

If something goes wrong:

```bash
# Rollback to previous revision
kubectl rollout undo deployment/vandura -n vandura

# Or rollback to specific revision
kubectl rollout undo deployment/vandura -n vandura --to-revision=2
```

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
