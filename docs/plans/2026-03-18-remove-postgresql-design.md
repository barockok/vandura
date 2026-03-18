# Remove PostgreSQL Dependency

**Date**: 2026-03-18
**Status**: Approved

## Motivation

Simplify the stack by removing PostgreSQL as a dependency. Session-scoped data should live with the session, audit logs should be emitted as events for external systems to consume, and user/credential management is unnecessary overhead.

## Current State

PostgreSQL stores: sessions, pending approvals, audit logs, users, credentials, agents, legacy tasks/messages. 14 tables, 8 migrations, 50+ query locations, 11 modules.

## Design

### SessionStore (Redis + Slack thread backup)

A single `SessionStore` class manages all session state. Redis is the primary store; the first bot message in the Slack thread is the backup via Slack message `metadata`.

**Redis schema:**
```
thread:{channelId}:{ts}  → sessionId (reverse lookup)
session:{id}             → Hash { pendingApproval: JSON | null }
```

**Slack message metadata (backup):**
```json
{
  "sessionId": "9d88a141-...",
  "pendingApproval": { "toolName": "db_write", "tier": 3, "toolUseId": "..." } | null
}
```

Backup stores only essential pending approval fields (toolName, tier, toolUseId) — no toolInput, to stay within Slack's 16KB metadata limit.

**API:**
```
SessionStore
  .create(sessionId, channelId, threadTs)
    → Redis SET + post first Slack message with metadata
  .resolve(channelId, threadTs)
    → Redis GET → miss? → read first Slack message metadata → rehydrate Redis
  .sandboxPath(sessionId)
    → pure function, derives path from sessionId + date
  .setPendingApproval(sessionId, approval)
    → Redis HSET + update Slack message metadata
  .getPendingApproval(sessionId)
    → Redis HGET
  .resolvePendingApproval(sessionId, decision, approverId)
    → Redis HSET (clear) + update Slack message metadata
```

**Recovery flow (Redis miss):**
1. Thread message arrives → `GET thread:{channel}:{ts}` → miss
2. Call Slack `conversations.history` → find first bot message → read `metadata`
3. Extract sessionId + pendingApproval → rehydrate Redis

### AuditEmitter (EventEmitter)

Replace all DB audit inserts with a Node.js EventEmitter singleton. No default consumer — external systems subscribe as needed.

**Events:**
- `tool_use` — { sessionId, toolName, toolInput, toolOutput, toolUseId, timestamp }
- `session_start` — { sessionId, channelId, userId, timestamp }
- `approval_requested` — { sessionId, toolName, tier, timestamp }
- `approval_resolved` — { sessionId, toolName, decision, approverId, timestamp }

### Agents Config

Read directly from `config/agents.yml` via existing `loadAgents()`. Drop the DB insert on startup.

### Users, Credentials

Dropped entirely. Roles derived from Slack workspace context. Credentials are contextual per session.

## What Gets Deleted

**Database layer (entire removal):**
- `src/db/pool.ts`, `src/db/connection.ts`, `src/db/migrate.ts`
- `src/db/migrations/001` through `008`

**Legacy modules:**
- `src/threads/manager.ts` — redundant with session management
- `src/approval/engine.ts` — dead code, rebuild later
- `src/audit/logger.ts` — replaced by AuditEmitter

**Other modules:**
- `src/users/manager.ts` — dropped
- `src/credentials/manager.ts` — dropped

**DB references removed from:**
- `src/agent/permissions.ts` — approval queries → SessionStore
- `src/agent/session.ts` — replaced by SessionStore
- `src/hooks/post-tool-use.ts` — DB insert → AuditEmitter.emit()
- `src/hooks/session-start.ts` — DB insert → AuditEmitter.emit()
- `src/hooks/approval-notifier.ts` — session lookup → SessionStore
- `src/app.ts` — pool, migrations, ThreadManager, AuditLogger, agent DB insert
- `src/health.ts` — DB check → Redis check

**Docker/config:**
- `docker-compose.yml` — remove postgres service
- `docker-compose.test.yml` — remove postgres test service
- `.env` — remove `DATABASE_URL`

**Tests deleted:**
- `tests/db/` — migration and connection tests
- `tests/threads/`, `tests/approval/`, `tests/audit/`, `tests/users/`
- `tests/integration/permissions.test.ts` — rewrite against Redis

## What Gets Created

**New files:**
- `src/session/store.ts` — SessionStore class
- `src/audit/emitter.ts` — AuditEmitter singleton

**Modified files:**
- `src/app.ts` — wire SessionStore, remove pool/migrations/legacy modules
- `src/queue/worker.ts` — use SessionStore
- `src/agent/permissions.ts` — pending approvals via SessionStore
- `src/hooks/pre-tool-use.ts` — approval lookup via SessionStore
- `src/hooks/post-tool-use.ts` — emit event
- `src/hooks/approval-notifier.ts` — session lookup via SessionStore
- `src/slack/gateway.ts` — pass message metadata on first bot reply
- `src/health.ts` — Redis health check
- `docker-compose.yml` — remove postgres service

**New tests:**
- `tests/session/store.test.ts`
- `tests/audit/emitter.test.ts`

## DB_TOOL_CONNECTION_URL

The target database for the agent's query tools (`export_query_to_csv`, MCP postgres server) is **unaffected**. This is the user's database, not the app's internal storage. `DB_TOOL_CONNECTION_URL` remains in env config.
