# Hooks-Based Maker-Checker Design

**Date:** 2026-03-09
**Status:** Approved

## Problem

The current maker-checker approval flow uses `canUseTool` callback in `sdk-runtime.ts`. This causes issues:
- The SDK posts its own deny message text to Slack instead of the proper approval request with instructions
- The interrupt/resume pattern adds complexity (session state management, resume with allowedTools)
- `canUseTool` mixes permission mechanism with business logic (tier checks, DB writes, Slack posting)

## Solution

Move maker-checker entirely into the `PreToolUse` hook. Remove `canUseTool` and the interrupt/resume pattern. Use `continueSession()` as the natural "resume" mechanism after approval.

## Design

### PreToolUse Hook

The hook becomes the core of maker-checker:

1. **Tier 1**: Return `{}` (pass-through, auto-allow)
2. **Tier 2/3**:
   - Check DB for a **resolved approval** for this session + tool name
     - If approved → return allow
     - If denied → return deny
   - If no resolved approval → store pending approval in DB, post approval request to Slack with "Reply `approve` or `deny`" instructions, return deny

The hook needs: DB pool, Slack client, tool policies, session ID (from hook input).

### canUseTool Removal

Remove from `sdk-runtime.ts`:
- `createPermissionHandler()` function
- `canUseTool` from query options
- `ApprovalRequiredError` class
- `trackingApprovalCallback` wrapper
- All interrupt/resume tracking (`approvalRequested`, `pendingApproval`, `toolUseId`)
- `resumeSession()` function (approvals flow through `continueSession()`)

### Approval Flow in app.ts

When user replies `approve`/`deny` in Slack thread:
1. Resolve the pending approval in DB (existing logic)
2. Queue a `continue_session` job with descriptive message:
   - Approved: "Tool `{toolName}` has been approved. Please proceed with the original request."
   - Denied: "Tool `{toolName}` has been denied. Please use an alternative approach."
3. Model retries → PreToolUse finds resolved approval → allows

Remove the `approve_tool` job type entirely.

### What Stays

- `pending_approvals` table and DB schema
- PostToolUse hook (audit logging)
- SessionStart hook
- Tool policies config (`tool-policies.yml`)
- `runSession()` and `continueSession()` (simplified, no approval tracking)
- Thread/task management
- `storePendingApproval`, `getPendingApproval`, `resolvePendingApproval` in permissions.ts
