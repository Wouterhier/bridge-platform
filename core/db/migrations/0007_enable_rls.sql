-- Row Level Security scaffolding.
-- Single-tenant for now, but structured for future multi-tenant isolation.
-- Tables without a location_id column use a permissive policy until tenant
-- context is threaded through the application.

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversations_location_isolation ON conversations
  USING (location_id = current_setting('app.current_location_id', true));

ALTER TABLE payment_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_sessions_location_isolation ON payment_sessions
  USING (true);

ALTER TABLE slot_menus ENABLE ROW LEVEL SECURITY;
CREATE POLICY slot_menus_location_isolation ON slot_menus
  USING (true);

ALTER TABLE processed_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY processed_messages_location_isolation ON processed_messages
  USING (true);

ALTER TABLE booking_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY booking_locks_location_isolation ON booking_locks
  USING (true);

-- Note: when the app starts setting app.current_location_id, revisit the
-- permissive policies above and replace them with tenant-scoped checks.
