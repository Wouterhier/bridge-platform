CREATE TABLE IF NOT EXISTS slot_menus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  slots JSONB NOT NULL,
  timezone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slot_menus_contact_id
  ON slot_menus (contact_id);
