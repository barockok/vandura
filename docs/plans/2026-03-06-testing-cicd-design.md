# §9 Testing & CI/CD — Design

## Goal

Improve test infrastructure with coverage reporting (CI badge), a manually-triggered E2E job, and multi-user E2E tests that exercise the full maker-checker approval flow against real Slack.

## Current State

- 24 test files, 138+ unit/integration tests (Vitest + Testcontainers)
- GitHub Actions CI: lint + typecheck + tests on every push/PR
- `docker-compose.test.yml` with Postgres, MinIO, Vandura service
- `tests/e2e/slack-flow.test.ts` with 4 test cases (single user)
- E2E excluded from regular `npm test` via `vitest.config.ts`
- E2E CI job stubbed but commented out

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
| 1 | Happy path: mention → thread → reply → DB persisted | Exists | Initiator |
| 2 | Bot ignores unrelated threads | Exists | Initiator |
| 3 | Tool execution (db_query) with results | Exists | Initiator |
| 4 | Tier-2: initiator approves own request | Exists (improve) | Initiator |
| 5 | Tier-3 approve: initiator requests → checker approves → executes | **New** | Both |
| 6 | Tier-3 reject: initiator requests → checker rejects → no execution | **New** | Both |
| 7 | Tier-3 self-approval denied: initiator tries to approve own tier-3 | **New** | Initiator |
| 8 | Thread follow-up in same thread | Exists | Initiator |
| 9 | Cleanup: delete test messages after run | **New** | — |

### 4. Files Changed

| File | Change |
|------|--------|
| `package.json` | Add `@vitest/coverage-v8`, `test:coverage` script |
| `vitest.config.ts` | Coverage config with thresholds |
| `.github/workflows/ci.yml` | Coverage in test job, e2e-slack with workflow_dispatch |
| `tests/e2e/slack-flow.test.ts` | Multi-user setup, new tier-3 scenarios, cleanup |
| `README.md` | Coverage badge |

## Out of Scope

- Offline Slack simulator / mock harness (keeping it real)
- Scheduled E2E runs (manual trigger only for now)
- Coverage threshold enforcement (start permissive, tighten later)
