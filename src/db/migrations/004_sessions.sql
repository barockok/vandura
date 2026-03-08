-- Sessions table for BullMQ worker architecture
-- Each session represents an agent conversation with sandbox directory

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_ts TEXT,
  sandbox_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Pending approvals for tier 2/3 tool requests
CREATE TABLE IF NOT EXISTS pending_approvals (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_input JSONB NOT NULL,
  tool_use_id TEXT NOT NULL,
  tier INT NOT NULL,
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE,
  decision TEXT,
  approver_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_session ON pending_approvals(session_id);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_resolved ON pending_approvals(resolved_at) WHERE resolved_at IS NULL;