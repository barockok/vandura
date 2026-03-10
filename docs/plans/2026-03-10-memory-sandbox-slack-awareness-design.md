# Memory Tool, Session Persistence & Slack Awareness — Design

## Goal

Add three capabilities to Vandura: (1) a persistent memory tool for cross-session knowledge, (2) durable session persistence for multi-node deployments, and (3) Slack thread awareness so the agent knows when to stay quiet.

## Feature 1: Global Memory Tool

### Architecture

A custom MCP server (stdio) that exposes two tools: `save_memory` and `recall_memory`. Runs alongside postgres and grafana as another entry in `config/mcp-servers.yml`.

### Storage

File-based. Markdown files at `~/.vandura/memory/`, organized by topic. The agent decides filenames naturally (e.g., `grafana-queries.md`, `krakend-troubleshooting.md`).

The memory directory persists across all sessions. In multi-node deployments, `~/.vandura/` lives on NFS alongside `~/.claude/`.

### Tools

- **`save_memory(topic, content)`** — Writes or appends to `~/.vandura/memory/{topic}.md`. Creates the file if it doesn't exist. If the file exists, appends with a timestamp separator.
- **`recall_memory(topic?)`** — If topic provided, reads and returns the file contents. If no topic, lists all available topic files with their last-modified dates.

### Sensitive Data Guard

Before writing, the tool scans content for patterns matching secrets:
- API keys: `sk-`, `sk_`, `glsa_`, `key-`
- Tokens: `xox`, `Bearer `, `token=`
- Generic: strings that look like base64-encoded secrets, passwords

If detected, the tool rejects the save with an error: "Content appears to contain sensitive data (API keys, tokens). Please redact before saving."

### System Prompt

Add to the system prompt:

> You have a persistent memory you can save to and recall from across sessions. When a user says "remember this" or "save how you did that", use the `save_memory` tool to persist the knowledge. Use `recall_memory` to check if you've solved similar problems before. Organize by topic naturally — one topic per problem domain.

### MCP Server Implementation

A small Node.js script (e.g., `src/mcp-servers/memory-server.ts`) using `@modelcontextprotocol/sdk` that:
1. Accepts stdio transport
2. Registers `save_memory` and `recall_memory` tools
3. Reads/writes from the memory directory path (passed via env var `VANDURA_MEMORY_DIR`)

Added to `config/mcp-servers.yml`:
```yaml
memory:
  name: "Memory"
  type: "stdio"
  command: "node"
  args: ["dist/mcp-servers/memory-server.js"]
  env:
    VANDURA_MEMORY_DIR: "${VANDURA_MEMORY_DIR}"
```

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
| New file | `src/mcp-servers/memory-server.ts` — MCP server for memory tools |
| Config | `config/mcp-servers.yml` — add memory server entry |
| Config | `.env.example` — add `VANDURA_MEMORY_DIR` |
| Runtime | `src/agent/sdk-runtime.ts` — fix `persistSession` to always `true` |
| Prompt | `src/agent/prompt.ts` — add memory, Slack awareness, white-label sections |
| Docker | `docker-compose.yml` — add `VANDURA_MEMORY_DIR` env var |
