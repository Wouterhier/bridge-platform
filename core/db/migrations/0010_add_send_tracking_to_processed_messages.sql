-- Add send tracking columns to processed_messages for at-least-once delivery
ALTER TABLE processed_messages
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_payload JSONB,
  ADD COLUMN IF NOT EXISTS send_attempts INT NOT NULL DEFAULT 0;

-- Backfill existing rows: assume historical sends succeeded
UPDATE processed_messages
  SET sent_at = processed_at,
      send_attempts = 1
  WHERE sent_at IS NULL;

-- Index for fast recovery queries on startup
CREATE INDEX IF NOT EXISTS idx_processed_messages_unsent
  ON processed_messages (sent_at, send_attempts)
  WHERE sent_at IS NULL;
