# Squadron Backlog

Items deferred from completed work, pending future implementation.

---

## Completed Work

### §14 MCP Connection Management (2026-03-07)

**Status**: ✅ Completed

**Deliverables**:
- `src/config/types.ts` - Added `connection_type` field to ToolPolicySchema
- `src/approval/engine.ts` - Connection type classification, shared connection guardrails helper
- `src/agent/prompt.ts` - System prompt section explaining shared vs per-user connections
- `src/credentials/manager.ts` - OAuth token refresh, health monitoring, token storage
- `src/health.ts` - OAuth health status in `/health` endpoint
- `src/tools/mcp-config.ts` - Chat-based MCP server configuration tool
- `src/db/migrations/003_oauth_health.sql` - Database schema for OAuth health monitoring
- `config/tool-policies.yml` - Updated with connection_type for all tools
- `README.md` - MCP Connection Management documentation section

**Features implemented**:
- Shared vs per-user connection types in tool policies
- Guardrails for shared connections (no full scans, indexed queries, limit results, upload to GCS)
- OAuth token automatic refresh before expiry
- OAuth health check endpoint with status reporting (valid/expiring/expired/error)
- Chat-based MCP configuration via `mcp_config` tool

---

### §10 Deployment Guide (2026-03-07)

**Status**: ✅ Completed

**Deliverables**:
- `k8s/migration-job.yml` - Kubernetes Job for database migrations
- `k8s/pre-deploy.sh` - Pre-deploy script to run migrations before rollout
- Updated `README.md` with:
  - Complete environment variable reference (required + optional)
  - Quick deploy instructions
  - Upgrade procedure
  - Rollback procedure
  - Troubleshooting guide with common issues
  - Per-agent Slack app creation walkthrough
  - Production deployment checklist

---

## E2E Test Scenarios (Deferred from §9 Implementation)

The following E2E test scenarios were identified in the §9 Testing & CI/CD design doc but deferred to allow focus on core functionality. These require new infrastructure or feature implementation before tests can be written.

### 1. Approval Timeout

**Scenario**: Test that pending approvals timeout after a configured duration and are automatically cancelled.

**Prerequisites**:
- Implement approval timeout mechanism in `src/approval/engine.ts`
- Add configuration for timeout duration (e.g., 5 minutes)
- Add cleanup job or lazy timeout check

**Test Cases**:
- Initiator requests tier-3 action, no one approves, timeout expires
- Verify pending approval is cancelled
- Verify user is notified of timeout
- Verify task can be re-requested after timeout

**Estimated Effort**: Medium (requires new feature implementation)

---

### 2. Busy Agent Detection

**Scenario**: Test that when an agent is at max capacity, new requests receive a busy status with alternatives.

**Prerequisites**:
- Implement busy detection in `src/app.ts` message flow
- Add `max_concurrent_tasks` enforcement at the chat entry point (currently configured but not enforced)
- Add "busy" response template with alternatives

**Test Cases**:
- Send two concurrent requests to same agent
- Verify second request receives "busy" status
- Verify alternatives are suggested (e.g., "try another agent", "wait for current task")
- Verify queue behavior if implemented

**Estimated Effort**: Medium (requires new feature implementation)

---

### 3. OAuth Token Refresh During Tool Call

**Scenario**: Test that OAuth tokens are refreshed automatically when they expire during tool execution.

**Prerequisites**:
- Implement OAuth token refresh logic for MCP tools
- Add token expiry detection
- Add transparent refresh mechanism that doesn't fail in-progress calls

**Test Cases**:
- Execute a long-running tool call
- Simulate token expiry during execution
- Verify token is refreshed automatically
- Verify tool call completes successfully
- Verify no user-visible error

**Estimated Effort**: High (requires OAuth infrastructure)

---

### 4. Large Result → S3 Upload → Signed URL Verification

**Scenario**: Full end-to-end test of large result handling with S3 upload and signed URL accessibility.

**Prerequisites**:
- S3/MinIO infrastructure running in E2E environment
- Signed URL generation configured

**Test Cases**:
- Execute query returning >4000 characters
- Verify bot uploads to S3 and posts signed URL
- Verify signed URL is accessible and returns correct content
- Verify URL expires after configured duration

**Status**: Partially implemented in `tests/e2e/slack-flow.test.ts` (verifies S3 path triggered, but not URL accessibility)

**Estimated Effort**: Low-Medium (requires MinIO in E2E CI)

---

### 5. Onboarding Flow (Full E2E)

**Scenario**: Complete onboarding flow from user joining channel to role selection.

**Prerequisites**:
- Ability to trigger `member_joined_channel` event in E2E (or test user that can join/leave)
- Test user not already onboarded

**Test Cases**:
- User joins channel
- Verify bot sends DM with welcome message and role options
- User replies with role selection
- Verify role is assigned in database
- Verify confirmation message is sent
- Verify user can now access tools per their role

**Status**: Partially implemented in `tests/e2e/slack-flow.test.ts` (verifies infrastructure, but not full flow)

**Estimated Effort**: Medium (requires test user management)

---

## Implementation Priority

| Priority | Item | Reason |
|----------|------|--------|
| 1 | Large Result/S3 | Most likely to occur in production, validates storage infrastructure |
| 2 | Onboarding Flow | Important for new user experience |
| 3 | Approval Timeout | UX improvement for stale approvals |
| 4 | Busy Agent | Edge case, depends on concurrent usage patterns |
| 5 | OAuth Refresh | Complex, depends on MCP tool requirements |

---

## Related Files

- Design doc: `docs/plans/2026-03-06-testing-cicd-design.md`
- E2E tests: `tests/e2e/slack-flow.test.ts`
- Approval engine: `src/approval/engine.ts`
- Agent runtime: `src/agent/runtime.ts`
- App entry point: `src/app.ts`
