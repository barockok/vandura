-- Add OAuth token health monitoring fields
ALTER TABLE user_connections
ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS health_status VARCHAR DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS refresh_count INT DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_refresh_error TEXT,
ADD COLUMN IF NOT EXISTS last_successful_use TIMESTAMPTZ;

-- Add index for health check queries
CREATE INDEX IF NOT EXISTS idx_user_connections_health
ON user_connections (health_status, token_expires_at);

-- Add index for expiring tokens
CREATE INDEX IF NOT EXISTS idx_user_connections_expiring
ON user_connections (token_expires_at)
WHERE token_expires_at IS NOT NULL AND health_status != 'expired';
