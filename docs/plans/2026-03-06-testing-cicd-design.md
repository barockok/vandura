# §9 Testing & CI/CD — Design

## Goal

Improve test infrastructure with coverage reporting (CI badge), a manually-triggered E2E job, and multi-user E2E tests that exercise the full maker-checker approval flow against real Slack.

## Current State (Updated)

- 24 test files, 139+ unit/integration tests (Vitest + Testcontainers)
- GitHub Actions CI: lint + typecheck + tests on every push/PR
- `docker-compose.test.yml` with Postgres, MinIO, Vandura service
- `tests/e2e/slack-flow.test.ts` with 10 test scenarios (6 E2E tests implemented, 4 with partial coverage)
- E2E excluded from regular `npm test` via `vitest.config.ts`
- E2E CI job configured with `workflow_dispatch` trigger
- Coverage reporting configured (`test:coverage` script)

## Design

### 1. Coverage Reporting with Badge

- Add `@vitest/coverage-v8` dev dependency
- Update `vitest.config.ts` with coverage config:
  - Reporter: `text`, `json-summary`, `json`
  - Threshold: set to current coverage level (no regressions), tighten over time
- Add `test:coverage` script to `package.json`
- CI `test` job runs with `--coverage`
- Use `davelosert/vitest-coverage-report-action` to post coverage summary to PR comments
- Add coverage badge to `README.md`

### 2. E2E CI Job (Manual Trigger)

- Add `workflow_dispatch` trigger to `ci.yml`
- Wire the `e2e-slack` job (currently commented out):
  - Trigger: `workflow_dispatch` only (not on PRs — saves tokens, needs live Slack)
  - Steps: checkout, setup node, npm ci, start docker-compose (Postgres + MinIO), start Vandura, run `test:e2e:slack`
  - Secrets: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `E2E_INITIATOR_TOKEN`, `E2E_CHECKER_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `DATABASE_URL` (constructed from docker-compose)

### 3. Multi-User E2E Tests

Two Slack users:
- **Initiator** (`E2E_INITIATOR_TOKEN` — HI) — posts @mentions, approves tier-2
- **Checker** (`E2E_CHECKER_TOKEN` — mark_baum) — approves/rejects tier-3

#### Test Scenarios

| # | Scenario | Status | Users |
|---|----------|--------|-------|
| 1 | Happy path: mention → thread → reply → DB persisted | ✅ Implemented | Initiator |
| 2 | Bot ignores unrelated threads | ✅ Implemented | Initiator |
| 3 | Tool execution (db_query) with results | ✅ Implemented | Initiator |
| 4 | Tier-2: initiator approves own request | ✅ Implemented | Initiator |
| 5 | Tier-3 approve: initiator requests → checker approves → executes | ✅ Implemented | Both |
| 6 | Tier-3 reject: initiator requests → checker rejects → no execution | ✅ Implemented | Both |
| 7 | Tier-3 self-approval denied: initiator tries to approve own tier-3 | ✅ Implemented | Initiator |
| 8 | Permission denied: user cannot access tool above their tier | ✅ Implemented | Initiator |
| 9 | Large result → S3 upload (partial) | ✅ Implemented | Initiator |
| 10 | Onboarding flow (infrastructure verify) | ✅ Implemented | Both |

**Deferred to backlog** (see `docs/backlog.md`):
- Approval timeout (requires new feature)
- Busy agent detection (requires new feature)
- OAuth token refresh during tool call (requires OAuth infrastructure)
- Large result signed URL accessibility (requires MinIO in CI)
- Full onboarding flow (requires test user management)

### 4. Files Changed

| File | Change |
|------|--------|
| `package.json` | ✅ `@vitest/coverage-v8`, `test:coverage` script |
| `vitest.config.ts` | ✅ Coverage config with thresholds |
| `.github/workflows/ci.yml` | ✅ Coverage in test job, e2e-slack with workflow_dispatch |
| `tests/e2e/slack-flow.test.ts` | ✅ Multi-user setup, 10 test scenarios (4 deferred) |
| `README.md` | ⏳ Coverage badge (run coverage to generate) |
| `docs/backlog.md` | ✅ Created — deferred items documented |

## Out of Scope (Backlog)

The following items were identified during implementation but deferred pending new feature development:

- Offline Slack simulator / mock harness
- Scheduled E2E runs (manual trigger only for now)
- Coverage threshold enforcement (start permissive, tighten later)
- **Approval timeout** — requires implementation in `src/approval/engine.ts`
- **Busy agent detection** — requires `max_concurrent_tasks` enforcement in message flow
- **OAuth token refresh** — requires OAuth infrastructure for MCP tools

See `docs/backlog.md` for detailed backlog items.
