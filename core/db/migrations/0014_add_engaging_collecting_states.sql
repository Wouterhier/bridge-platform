-- Migration 0014: add ENGAGING + COLLECTING states, retire granular COLLECTING_* states
-- Introduced in v0.2.0 (SCM flow-enforcement spec: intent-driven flow rewrite)

-- Step 1: add new enum values (Postgres requires ALTER TYPE ADD VALUE)
ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'ENGAGING' AFTER 'NEW';
ALTER TYPE conversation_state ADD VALUE IF NOT EXISTS 'COLLECTING' AFTER 'ENGAGING';

-- Step 2: migrate any existing rows with old collection states to COLLECTING
UPDATE conversations
  SET current_state = 'COLLECTING'
  WHERE current_state IN ('COLLECTING_NAME', 'COLLECTING_PHONE', 'COLLECTING_EMAIL');

-- Step 3: old values cannot be dropped from a Postgres enum without recreating the type.
-- They are retired (never written by application code) but remain in the enum definition
-- to avoid needing a full type-recreate+table-rewrite cycle on a live table.
-- Application code no longer writes COLLECTING_NAME/PHONE/EMAIL; rows have been migrated above.
