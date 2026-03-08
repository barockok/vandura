# Implementation Plan: BullMQ Workers with Agent SDK

## Prerequisites

- [ ] Redis available (local or cloud)
- [ ] Node.js 18+

## Phase 1: Foundation

### Step 1.1: Install Dependencies
```bash
npm install bullmq ioredis
```

### Step 1.2: Create Database Migration
Create `src/db/migrations/004_sessions.sql`:
- Sessions table
- Pending approvals table

### Step 1.3: Create Queue Infrastructure
Create `src/queue/`:
- `types.ts` - Job type definitions
- `index.ts` - BullMQ queue setup
- `worker.ts` - Worker skeleton

## Phase 2: Agent SDK Integration

### Step 2.1: MCP Config Loader
Create `src/agent/mcp-loader.ts`:
- Load `mcp-servers.yml`
- Convert to SDK `McpServerConfig` format
- Handle environment variable substitution

### Step 2.2: Permission Handler
Create `src/agent/permissions.ts`:
- Load tool tiers from `tool-policies.yml`
- Implement `canUseTool` callback
- Tier 1: auto-allow
- Tier 2/3: request approval

### Step 2.3: Runtime Wrapper
Update `src/agent/runtime.ts`:
- Replace current implementation with SDK `query()`
- Add sandbox directory creation
- Add interrupt/resume logic
- Stream messages to Slack

## Phase 3: Worker Implementation

### Step 3.1: Session Management
Create `src/agent/session.ts`:
- Create sandbox directories with date partitioning
- Store session metadata in PostgreSQL
- Update session status

### Step 3.2: Worker Logic
Implement `src/queue/worker.ts`:
- Handle `start_session` jobs
- Handle `continue_session` jobs
- Handle `approve_tool` jobs
- Error handling and retries

### Step 3.3: Slack Responder
Create `src/slack/responder.ts`:
- Send messages to Slack channels
- Send approval requests
- Handle thread replies

## Phase 4: Slack Gateway Refactor

### Step 4.1: Update Gateway
Update `src/slack/gateway.ts`:
- Remove direct agent calls
- Queue jobs for messages
- Handle approval responses

### Step 4.2: Update App Entry
Update `src/index.ts`:
- Start worker
- Start Slack gateway
- Handle shutdown gracefully

## Phase 5: Cleanup & Testing

### Step 5.1: Remove Old Code
- Remove `src/mcp/sdk-manager.ts` (use SDK native)
- Remove old `src/agent/tool-executor.ts`
- Remove old approval flow code

### Step 5.2: Update Tests
- Add queue tests
- Add worker tests
- Add permission handler tests
- Update E2E tests

### Step 5.3: Documentation
- Update README
- Update CLAUDE.md
- Add architecture diagrams

---

## Task Breakdown

### Priority 1: Foundation
1. Install BullMQ + ioredis
2. Create database migration for sessions
3. Create queue types and setup

### Priority 2: Core Worker
4. Create session management
5. Create MCP loader (SDK format)
6. Create permission handler
7. Create runtime wrapper with SDK

### Priority 3: Integration
8. Implement worker job handlers
9. Create Slack responder
10. Update Slack gateway

### Priority 4: Cleanup
11. Remove old code
12. Update tests
13. Update documentation

---

## Verification Checkpoints

1. **After Phase 1:** Queue can accept jobs, workers connect
2. **After Phase 2:** SDK query() works with MCP servers
3. **After Phase 3:** Full job flow works (without Slack)
4. **After Phase 4:** End-to-end Slack flow works
5. **After Phase 5:** All tests pass, old code removed