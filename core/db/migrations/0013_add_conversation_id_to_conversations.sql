ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ghl_conversation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_ghl_conversation_id ON conversations(ghl_conversation_id);
