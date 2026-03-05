CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR NOT NULL UNIQUE,
  avatar VARCHAR,
  role VARCHAR,
  personality VARCHAR,
  tools JSONB,
  system_prompt_extra TEXT,
  max_concurrent_tasks INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_id VARCHAR UNIQUE,
  display_name VARCHAR,
  role VARCHAR,
  tool_overrides JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  onboarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shared_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR NOT NULL UNIQUE,
  provider VARCHAR NOT NULL,
  credentials_enc BYTEA,
  credentials_iv BYTEA,
  credentials_tag BYTEA,
  dek_enc BYTEA,
  config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_shared_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  shared_connection_id UUID NOT NULL REFERENCES shared_connections(id),
  approved_by VARCHAR,
  access_level VARCHAR NOT NULL DEFAULT 'read',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, shared_connection_id)
);

CREATE TABLE user_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider VARCHAR NOT NULL,
  access_token_enc BYTEA,
  refresh_token_enc BYTEA,
  token_iv BYTEA,
  token_tag BYTEA,
  dek_enc BYTEA,
  token_expires_at TIMESTAMPTZ,
  scopes JSONB,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_thread_ts VARCHAR,
  slack_channel VARCHAR,
  agent_id UUID REFERENCES agents(id),
  initiator_slack_id VARCHAR,
  checker_slack_id VARCHAR,
  topic TEXT,
  status VARCHAR NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  role VARCHAR NOT NULL,
  content TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  tool_name VARCHAR NOT NULL,
  tool_input JSONB,
  tier SMALLINT,
  requested_by VARCHAR,
  approved_by VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'pending',
  guardrail_output TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  agent_id UUID REFERENCES agents(id),
  action VARCHAR NOT NULL,
  actor VARCHAR,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES (1);
