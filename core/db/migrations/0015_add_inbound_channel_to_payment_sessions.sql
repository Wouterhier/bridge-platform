-- Migration 0015: store the inbound channel on payment_sessions
-- so onPaymentConfirmed can reply on the same channel the patient used.
ALTER TABLE payment_sessions
  ADD COLUMN IF NOT EXISTS inbound_channel TEXT NOT NULL DEFAULT 'SMS';
