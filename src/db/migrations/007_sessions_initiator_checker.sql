-- Add initiator and checker columns to sessions table for make-checker flow
-- These columns are needed for the hooks-based approval system

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS initiator_slack_id TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS checker_slack_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_initiator ON sessions(initiator_slack_id);
CREATE INDEX IF NOT EXISTS idx_sessions_checker ON sessions(checker_slack_id);
