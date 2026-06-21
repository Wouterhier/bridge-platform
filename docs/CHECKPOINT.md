# Build Checkpoint — 2026-06-21

## Currently live
**Tag:** `v0.2.0-scm-bridge` (`fc7cb1e`)
**Live route:** `https://ai.romea.ai/selfcaremen` → SGP1 :3204 (conversation) + :3205 (payment)
**Old bridge:** scm-bridge.js on :3203 still deployed, stopped, reference only

## What works end-to-end (confirmed live)
- GHL inbound webhook parsed correctly (numeric type 29, no message id)
- **NEW:** Intent-driven flow: NEW → ENGAGING → SELECTING_SERVICE → COLLECTING → ... → CONFIRMED
- **NEW:** Deterministic gate (gateApiCall) blocks booking until all mandatory fields are present and valid
- **NEW:** DOB normalizer with ambiguity detection (flags "09/06/1990" instead of guessing)
- **NEW:** NZ phone default — bare 021/09 numbers auto-normalize to +64 E.164
- **NEW:** No silent defaults in mapIntakeFields — missing DOB does NOT become "01/01/1990"
- **NEW:** Webhook seeding — known fields (name/phone/email) from inbound payload pre-fill collected
- **NEW:** API error diagnosis with field-level loopback — Acuity errors map to missing fields, return to COLLECTING
- Sonnet generates warm coordinator voice (v0.1.15 voice rewrite)
- GHL send: `{type: "Live_Chat", contactId, message}` with `Version: 2021-04-15` — WORKS
- Reply confirmed in GHL widget, `sent_at` written to Postgres
- Free eligibility booking tested end-to-end

## What still needs testing
- Paid path (Stripe checkout → webhook → Acuity booking)
- Emergency escalation (HUMAN_TOUCH state)
- Contact upsert (name/phone/email written to GHL contact record)
- API error loopback in production (Acuity field-level errors)

## Completed builds
- `v0.2.0-scm-bridge` — 8-step flow enforcement build (see `docs/SCM-FLOW-ENFORCEMENT-SPEC.md`)

## Key files
- Service: `clients/scm/service/src/conversation-service.ts`
- Flow states: `clients/scm/flow/src/states.ts`
- Gate: `clients/scm/flow/src/gate.ts`
- Field spec: `clients/scm/flow/src/field-spec.ts`
- Validators: `clients/scm/flow/src/validators.ts`
- Voice: `clients/scm/flow/src/generate.ts`
- GHL client: `core/clients-base/ghl/src/ghl-client.ts`
- Hard-won GHL facts: `docs/GHL-FACTS.md`
- Deploy procedure: `docs/rollback.md`
- Architecture: `docs/ARCHITECTURE.md`
