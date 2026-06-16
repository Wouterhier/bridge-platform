CREATE TABLE IF NOT EXISTS booking_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id TEXT NOT NULL UNIQUE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_locks_expires_at
  ON booking_locks (expires_at);
