CREATE TABLE IF NOT EXISTS processed_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT NOT NULL UNIQUE,
  contact_id TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_contact_processed_at
  ON processed_messages (contact_id, processed_at);
