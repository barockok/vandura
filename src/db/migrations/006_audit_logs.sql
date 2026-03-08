-- Audit logs for comprehensive tool execution tracking
-- Complements the existing audit_log table with SDK hook-based logging

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_input JSONB NOT NULL,
  tool_output JSONB,
  tool_use_id TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 1,
  decision TEXT NOT NULL DEFAULT 'allowed', -- 'allowed' | 'denied' | 'approved'
  approver_id TEXT, -- Slack user ID who approved (for tier 2/3)
  pending_approval_id UUID REFERENCES pending_approvals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_session ON audit_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tool ON audit_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_approval ON audit_logs(pending_approval_id);
