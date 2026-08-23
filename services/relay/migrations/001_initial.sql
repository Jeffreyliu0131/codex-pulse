CREATE TABLE IF NOT EXISTS hosts (
  id uuid PRIMARY KEY,
  label varchar(64) NOT NULL,
  secret_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  bridge_version varchar(32),
  queued_event_count integer NOT NULL DEFAULT 0,
  source_health jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_sequence bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pairing_sessions (
  id uuid PRIMARY KEY,
  code_hash char(64) NOT NULL UNIQUE,
  status varchar(16) NOT NULL CHECK (
    status IN ('created', 'claimed', 'approved', 'rejected', 'consumed')
  ),
  claimed_label varchar(64),
  claimed_host_id uuid REFERENCES hosts(id) ON DELETE SET NULL,
  claim_token_hash char(64) UNIQUE,
  credential_delivered_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS pairing_sessions_expires_idx
  ON pairing_sessions (expires_at);

CREATE TABLE IF NOT EXISTS host_nonces (
  host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  nonce varchar(128) NOT NULL,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (host_id, nonce)
);

CREATE INDEX IF NOT EXISTS host_nonces_seen_idx ON host_nonces (seen_at);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  task_key varchar(128) NOT NULL,
  alias varchar(64),
  state varchar(24) NOT NULL,
  attention_reason varchar(24),
  source varchar(24) NOT NULL,
  source_precision varchar(24) NOT NULL,
  source_updated_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  relay_received_at timestamptz NOT NULL,
  expires_at timestamptz,
  revision bigint NOT NULL,
  unread boolean NOT NULL DEFAULT true,
  muted boolean NOT NULL DEFAULT false,
  notify_on jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (host_id, task_key)
);

CREATE INDEX IF NOT EXISTS tasks_host_idx ON tasks (host_id);
CREATE INDEX IF NOT EXISTS tasks_observed_idx ON tasks (observed_at DESC);

CREATE TABLE IF NOT EXISTS events (
  event_id varchar(128) PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  type varchar(32) NOT NULL,
  reason varchar(24),
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source varchar(24) NOT NULL,
  source_precision varchar(24) NOT NULL,
  sequence bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  unread boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS events_received_idx ON events (received_at DESC);
CREATE INDEX IF NOT EXISTS events_host_sequence_idx ON events (host_id, sequence DESC);
CREATE INDEX IF NOT EXISTS events_expires_idx ON events (expires_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY,
  endpoint_hash char(64) NOT NULL UNIQUE,
  payload_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_success_at timestamptz,
  disabled_at timestamptz,
  error_category varchar(64)
);

CREATE TABLE IF NOT EXISTS rate_limit_attempts (
  id bigserial PRIMARY KEY,
  scope varchar(32) NOT NULL,
  fingerprint char(64) NOT NULL,
  attempted_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limit_attempts_lookup_idx
  ON rate_limit_attempts (scope, fingerprint, attempted_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  category varchar(64) NOT NULL,
  subject_id varchar(128),
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_idx ON audit_events (occurred_at DESC);
