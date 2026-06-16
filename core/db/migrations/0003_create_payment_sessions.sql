CREATE TABLE IF NOT EXISTS payment_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  slot_iso TIMESTAMPTZ NOT NULL,
  appointment_type_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations(id),
  idempotency_key TEXT UNIQUE,
  collected_fields JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_contact_status
  ON payment_sessions (contact_id, status);

CREATE TRIGGER trg_payment_sessions_updated_at
  BEFORE UPDATE ON payment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
