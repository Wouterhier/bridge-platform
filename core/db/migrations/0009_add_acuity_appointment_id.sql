ALTER TABLE payment_sessions
  ADD COLUMN IF NOT EXISTS acuity_appointment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_sessions_acuity_appointment_id
  ON payment_sessions (acuity_appointment_id);
