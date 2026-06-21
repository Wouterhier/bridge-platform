# Build Checkpoint — 2026-06-21

## Currently live
**Tag:** `v0.1.15-scm-bridge` (`eb6caee`)
**Live route:** `https://ai.romea.ai/selfcaremen` → SGP1 :3204 (conversation) + :3205 (payment)
**Old bridge:** scm-bridge.js on :3203 still deployed, stopped, reference only

## What works end-to-end (confirmed live)
- GHL inbound webhook parsed correctly (numeric type 29, no message id)
- State machine: NEW → COLLECTING_NAME → ... → CONFIRMED
- Sonnet generates warm coordinator voice (v0.1.15 voice rewrite)
- GHL send: `{type: "Live_Chat", contactId, message}` with `Version: 2021-04-15` — WORKS
- Reply confirmed in GHL widget, `sent_at` written to Postgres
- Free eligibility booking tested end-to-end

## What still needs testing
- Paid path (Stripe checkout → webhook → Acuity booking)
- Emergency escalation (HUMAN_TOUCH state)
- Contact upsert (name/phone/email written to GHL contact record)

## Pending builds
See: `docs/SCM-FLOW-ENFORCEMENT-SPEC.md` (the next build)

## Key files
- Service: `clients/scm/service/src/conversation-service.ts`
- Voice: `clients/scm/flow/src/generate.ts`
- GHL client: `core/clients-base/ghl/src/ghl-client.ts`
- Hard-won GHL facts: `docs/GHL-FACTS.md`
- Deploy procedure: `docs/rollback.md`
- Architecture: `docs/ARCHITECTURE.md`
