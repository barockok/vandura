-- Add server_session_id column to sessions table
-- This stores the server-side session ID for conversation continuity

ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS server_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_server ON sessions(server_session_id);
