# Memory Tool, Session Persistence & Slack Awareness — Design

## Goal

Add three capabilities to Vandura: (1) a persistent memory tool for cross-session knowledge, (2) durable session persistence for multi-node deployments, and (3) Slack thread awareness so the agent knows when to stay quiet.

## Feature 1: Global Memory Tool

### Architecture

Internal (programmatic) — no MCP server. The agent uses Claude Code's built-in Read, Write, and Glob tools to manage memory files directly. A PreToolUse hook guards against sensitive data being written.

This avoids a separate process, stdio transport overhead, and MCP config registration. Simpler to deploy, test, and maintain.

### Storage

File-based. Markdown files at `~/.vandura/memory/`, organized by topic. The agent decides filenames naturally (e.g., `grafana-queries.md`, `krakend-troubleshooting.md`).

The memory directory persists across all sessions. In multi-node deployments, `~/.vandura/` lives on NFS alongside `~/.claude/`.

### How It Works

1. **System prompt** tells the agent the memory directory path and conventions (use Write to save, Read to recall, Glob to list topics).
2. **PreToolUse hook** intercepts Write/Edit tool calls targeting the memory directory. Scans content for sensitive data patterns. Blocks the write if secrets are detected.
3. **`src/tools/memory.ts`** exports `containsSensitiveData()` — used by the hook.

The agent manages file format naturally (markdown with timestamps). No structured tool schema needed — Read/Write are already structured Claude Code tools.

### Sensitive Data Guard

The PreToolUse hook scans content before any write to the memory directory:
- API keys: `sk-`, `sk_`, `glsa_`, `key-`
- Tokens: `xox`, `Bearer `, `token=`
- Generic: passwords, PEM private keys

If detected, the hook blocks the write with: "Content appears to contain sensitive data (API keys, tokens). Please redact before saving."

### System Prompt

Add to the system prompt:

> You have a persistent memory at `{VANDURA_MEMORY_DIR}`. Use the Write tool to save memories as markdown files (one per topic, e.g., `grafana-queries.md`). Use Read to recall them. Use Glob to list available topics. When a user says "remember this" or "save how you did that", write to your memory directory. Check memory before solving problems you may have solved before. NEVER save API keys, tokens, passwords, or secrets — the system will reject the write.

## Feature 2: Session Directory & Multi-Node Persistence

### Current State

- Sandbox path: `~/.claude/sessions/YYYY-MM-DD/{uuid}` (configurable via `CLAUDE_SESSIONS_DIR`)
- Claude Code stores transcripts at `~/.claude/projects/{sanitized-cwd}/{session-id}.jsonl`
- `persistSession` is set to `false` when resuming — transcripts may not be written

### Changes

1. **Fix `persistSession`**: Always `true`. Remove the `!isResuming` logic. Claude Code needs to persist transcripts so any node can resume.
2. **Shared storage**: Both `~/.claude/` and `~/.vandura/` live on NFS in multi-node deployments. Configured via `HOME` or explicit mount paths.
3. **No new directories**: The sandbox path IS the workspace. No separate `workspace/` subdirectory needed.

### Multi-Node Resume Flow

1. Node A processes `start_session` → creates sandbox on NFS, Claude Code writes `.jsonl` to `~/.claude/projects/`
2. User replies in thread → `continue_session` job lands on Node B
3. Node B reads session from DB → gets sandbox path on NFS → calls SDK `resume` → Claude Code finds `.jsonl` on shared NFS → resumes conversation

## Feature 3: Slack Thread Awareness

### System Prompt Addition

Add to the system prompt:

> You are operating inside a Slack thread. Multiple people may participate in the thread. Not every message is directed at you — people have side conversations, tag coworkers, or discuss things amongst themselves. Use your judgment: respond when you're being spoken to or asked something, stay quiet when the conversation is clearly between other people. If someone @mentions another person without addressing you, that's probably not for you.

No gateway code changes. The model handles it via prompt guidance.

### White-Label Identity

Add to the system prompt:

> You are Vandura. Never mention Claude, Anthropic, Claude Code, or any underlying AI provider or technology. If asked what you are, you are Vandura — an AI assistant built for this team. Do not reference your model name, training, or provider under any circumstances.

## Summary of Changes

| Area | What Changes |
|------|-------------|
| New file | `src/tools/memory.ts` — `containsSensitiveData()` utility |
| Hook | `src/hooks/pre-tool-use.ts` — intercept writes to memory dir, scan for secrets |
| Config | `.env.example` — add `VANDURA_MEMORY_DIR` |
| Runtime | `src/agent/sdk-runtime.ts` — fix `persistSession` to always `true` |
| Prompt | `src/agent/prompt.ts` — add memory, Slack awareness, white-label sections |
| Docker | `docker-compose.yml` — add `VANDURA_MEMORY_DIR` env var |
