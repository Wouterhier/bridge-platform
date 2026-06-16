-- Step 1 remediation: enforce per-client DB isolation and verify four critical DB-level constraints.
-- This migration assumes it runs against the dedicated selfcaremen_bridge database.

-- 1. Conversation state enum -------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_state') THEN
        CREATE TYPE conversation_state AS ENUM (
            'NEW',
            'COLLECTING_NAME',
            'COLLECTING_PHONE',
            'COLLECTING_EMAIL',
            'SELECTING_SERVICE',
            'SHOWING_SLOTS',
            'AWAITING_SELECTION',
            'CREATING_CHECKOUT',
            'AWAITING_PAYMENT',
            'BOOKING_ACUITY',
            'CONFIRMED',
            'HUMAN_TOUCH',
            'DND',
            'NATURAL_ENDING'
        );
    END IF;
END $$;

ALTER TABLE conversations
    ALTER COLUMN current_state TYPE conversation_state
    USING current_state::conversation_state;

-- 2. payment_sessions constraints -------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payment_sessions_stripe_session_id_key'
          AND conrelid = 'payment_sessions'::regclass
    ) THEN
        ALTER TABLE payment_sessions
            ADD CONSTRAINT payment_sessions_stripe_session_id_key UNIQUE (stripe_session_id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'payment_sessions_idempotency_key_key'
          AND conrelid = 'payment_sessions'::regclass
    ) THEN
        ALTER TABLE payment_sessions
            ADD CONSTRAINT payment_sessions_idempotency_key_key UNIQUE (idempotency_key);
    END IF;
END $$;

ALTER TABLE payment_sessions
    ALTER COLUMN stripe_session_id SET NOT NULL;

-- 3. processed_messages primary key migration --------------------------------
-- Drop the synthetic UUID primary key and promote message_id to PK.
ALTER TABLE processed_messages
    DROP CONSTRAINT IF EXISTS processed_messages_message_id_key;

ALTER TABLE processed_messages
    DROP CONSTRAINT processed_messages_pkey;

ALTER TABLE processed_messages
    ADD PRIMARY KEY (message_id);

ALTER TABLE processed_messages
    ALTER COLUMN message_id SET NOT NULL;

-- 4. booking_locks acquire function ------------------------------------------
CREATE OR REPLACE FUNCTION acquire_booking_lock(
    contact_id TEXT,
    conversation_id UUID,
    expires_at TIMESTAMPTZ
)
RETURNS SETOF booking_locks
LANGUAGE sql
AS $$
    INSERT INTO booking_locks (contact_id, conversation_id, expires_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (contact_id) DO UPDATE SET
        conversation_id = EXCLUDED.conversation_id,
        expires_at = EXCLUDED.expires_at,
        created_at = now()
    WHERE booking_locks.expires_at < now()
    RETURNING *;
$$;

-- 5. Per-client isolation: non-owner app role --------------------------------
-- The dedicated selfcaremen_bridge database already provides tenant isolation.
-- Create a non-owner role so the application cannot bypass RLS or alter schema.
-- NOTE: CREATE ROLE requires CREATEROLE/superuser privileges. Run this part as
-- a privileged user (e.g. postgres) before applying the rest of the migration.
--
--   CREATE ROLE selfcaremen_app WITH LOGIN NOINHERIT PASSWORD '<generated>';
--
-- The remaining grants are issued by scm_bridge because it owns the objects.

-- Grant connection to the database.
GRANT CONNECT ON DATABASE selfcaremen_bridge TO selfcaremen_app;

-- Grant schema usage and table/sequence privileges.
GRANT USAGE ON SCHEMA public TO selfcaremen_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO selfcaremen_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO selfcaremen_app;

-- Ensure future objects are accessible too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO selfcaremen_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO selfcaremen_app;

-- 6. Drop multi-tenant RLS scaffolding (no longer needed in per-client DB) ---
DROP POLICY IF EXISTS conversations_location_isolation ON conversations;
DROP POLICY IF EXISTS payment_sessions_location_isolation ON payment_sessions;
DROP POLICY IF EXISTS slot_menus_location_isolation ON slot_menus;
DROP POLICY IF EXISTS processed_messages_location_isolation ON processed_messages;
DROP POLICY IF EXISTS booking_locks_location_isolation ON booking_locks;

ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE slot_menus DISABLE ROW LEVEL SECURITY;
ALTER TABLE processed_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE booking_locks DISABLE ROW LEVEL SECURITY;
