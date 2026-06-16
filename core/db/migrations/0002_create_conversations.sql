CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  current_state TEXT NOT NULL,
  collected_fields JSONB NOT NULL DEFAULT '{}',
  context JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_location_contact
  ON conversations (location_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at);

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
