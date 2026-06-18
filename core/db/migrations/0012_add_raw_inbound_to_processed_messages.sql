-- Add raw_inbound column for state-A recovery (received but never processed)
ALTER TABLE processed_messages
  ADD COLUMN IF NOT EXISTS raw_inbound JSONB;
