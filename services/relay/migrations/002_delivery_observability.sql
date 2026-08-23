ALTER TABLE events
  ADD COLUMN IF NOT EXISTS push_attempted_at timestamptz;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS push_accepted_at timestamptz;

ALTER TABLE events
  -- Set only when an authenticated notification deep link is consumed.
  ADD COLUMN IF NOT EXISTS opened_at timestamptz;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS push_attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS push_error_category varchar(64);

CREATE INDEX IF NOT EXISTS events_push_accepted_idx
  ON events (push_accepted_at DESC);
