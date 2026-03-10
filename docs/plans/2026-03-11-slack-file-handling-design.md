# Slack File Handling — Design Document

**Goal:** Two independent features: (1) a tool for the AI agent to upload files natively to Slack threads, and (2) a handler for user file attachments in thread messages.

**Architecture:** Both features are independent. The upload tool is a new Tier 1 tool that calls Slack's `files.uploadV2`. The attachment handler is gateway/worker logic that downloads user files to the session sandbox and passes images as vision inputs.

## Feature 1: `slack_upload_file` Tool

**New file:** `src/tools/slack-upload-file.ts`

A Tier 1 tool the AI agent calls to post files directly into the Slack thread.

**Inputs:**
- `filename` (string, required) — e.g. `"report.csv"`
- `content` (string, required) — file content as string or base64
- `content_type` (string, optional) — MIME type, defaults to `application/octet-stream`
- `title` (string, optional) — display title in Slack

**Behavior:**
- Uses Slack `files.uploadV2` API
- Posts file to the session's `channelId` + `threadTs`
- Returns confirmation with Slack file permalink
- Registered as Tier 1 (auto-execute, no approval)

**Session context:** `channelId` and `threadTs` injected at tool registration (same pattern as existing `upload_file` tool).

**System prompt:** Add guidance to prefer `slack_upload_file` over `upload_file` for Slack thread responses.

## Feature 2: File Attachment Handler

**Modified files:** `src/slack/gateway.ts`, `src/queue/worker.ts`

When a user posts a thread message with file attachments:

1. Gateway detects `message.files[]` on incoming Slack event
2. For each file:
   - Download via Slack file URL + bot token auth
   - Save to `<sandboxPath>/uploads/<original_filename>`
   - Images (png, jpg, gif, webp): also base64-encode for Claude vision input
   - All other types: save to sandbox only
3. User message augmented with file context:
   ```
   [User uploaded: report.csv → /uploads/report.csv]
   [User uploaded: screenshot.png → /uploads/screenshot.png (attached as image)]
   Here's the data I mentioned
   ```
4. Images passed as vision content blocks to the SDK query

**No new tool** — pure gateway/worker logic. Agent sees files as sandbox paths (Read tool) and images as vision inputs.
