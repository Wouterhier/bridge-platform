# SCM Bridge — Low-Entry Conversational Flow with Deterministic Field Enforcement
## Design Spec (build plan for next session)

This replaces the rigid linear collection funnel (NEW → COLLECTING_NAME → COLLECTING_PHONE → ...) with the design that matches the n8n and old bridge: the AI drives a low-entry conversation, and deterministic code gates every API call so nothing is ever skipped or fabricated.

Status: SPEC ONLY. Do not build at the end of an all-night session. Build deliberately. The current bridge (v0.1.14 + voice rewrite) works end-to-end and is the stable checkpoint to return to.

---

## Core principle (unchanged, restated)

The AI owns the CONVERSATION. The code owns the CONSEQUENCES.
- AI: warm, low-entry, helpful, engaging. Answers questions. Not everyone books. Collects details naturally, combined, only when there is booking intent. Extracts messy human input (any DOB format, info given several turns ago).
- CODE: validates and normalizes every value, gates every API call, never fabricates, never lets a mandatory field through missing or invalid, diagnoses API errors.

Neither alone is trusted. AI extraction is separated from AI generation, so a generated reply can never inject a field value. Only code-validated values reach an API call.

---

## 1. Low-entry conversation (not a funnel)

Replace the mandatory linear states with an open conversational model:

- Entry is low-friction. A patient saying "hi" or asking a question gets help and answers, NOT a demand for name/phone.
- Name and contact details are NOT required to converse. They are only required to BOOK, and only the ones Acuity requires for the chosen appointment type.
- The AI leads: helps, answers from KB, qualifies gently, and moves toward booking when the patient shows intent. Some patients only ask questions and never book. That is fine and expected.
- Make it about the patient. Combine questions naturally ("what's your name, and what were you hoping to sort out?") rather than one field per turn.
- Assume New Zealand. Never ask for country code. Code normalizes the phone to NZ (+64) format.
- NEVER re-ask anything already present from the webhook. Form and WhatsApp leads often arrive with name, phone, or email already populated. Seed collected-fields from the webhook payload at conversation start; the AI only asks for what is genuinely still missing.

State model (conceptual): a single open ENGAGING phase, plus booking sub-phases that only activate on booking intent:
- ENGAGING: AI helps/answers/qualifies. No forced collection.
- BOOKING_INTENT detected → SELECTING_SERVICE (which Acuity type) → COLLECTING (only Acuity-required fields still missing) → SHOWING_SLOTS → AWAITING_SELECTION → [CHECKOUT if paid] → BOOKING → CONFIRMED.
- HUMAN_TOUCH terminal for escalation.

The COLLECTING phase is NOT a fixed sequence. It is "whatever Acuity-mandatory fields for this type are still missing", asked naturally, in any order, combined where sensible.

---

## 2. Per-appointment-type field spec (known, code-held, Acuity-verifiable)

The mandatory/optional/post-booking fields per appointment type are already known from when the bridges were built (they live implicitly in mapIntakeFields). Make them explicit:

Define, per Acuity appointment type id, a field spec:
```
{
  appointmentTypeId: 79429909,
  fields: [
    { id: 16762638, key: "dob",      label: "date of birth",         requirement: "mandatory",    type: "date" },
    { id: 16763392, key: "address",  label: "address",               requirement: "optional",     type: "text" },
    { id: 16736084, key: "questions",label: "questions to discuss",  requirement: "post_booking", type: "text" },
    ...
  ]
}
```
- requirement ∈ mandatory | optional | post_booking
- type drives validation/normalization (date, phone, email, text, enum)
- These are KNOWN and hardcoded. They do not change.
- FALLBACK: if a type is missing from the spec or Claw is unsure, fetch Acuity `GET /forms` (returns each field with its `required` flag) to verify, then add it to the spec. API check is a safety net, not the primary path.

Remove ALL silent defaults from mapIntakeFields. No more `dob || "01/01/1990"`, `address || "Not provided"`, `meds || "None"`. A missing mandatory field is MISSING, to be collected, never fabricated. (Optional fields may be omitted from the call entirely; they are not defaulted either.)

---

## 3. Field collection: AI extracts (messy), code validates + normalizes (strict)

The split that makes "is the code smart enough" a non-issue:

- AI EXTRACTION (extract()): pulls field values from the patient's actual messages across the FULL conversation history, in any human format. "I'm 30, born July 26 1995", "26/7/95", "09-06-1990" all extract to a candidate DOB. The AI handles timing (value given several turns ago) and format variance. extract() reads ONLY patient messages, never generates values.
- CODE VALIDATION + NORMALIZATION (per field type): takes the AI's extracted candidate and:
  - normalizes to Acuity's required canonical format (DOB → Acuity's expected date format; phone → +64 NZ E.164; email → lowercased validated),
  - validates it is real and sensible (valid date, plausible age, valid email, valid NZ number),
  - REJECTS if it cannot be confidently normalized/validated → field stays "missing/invalid" → loop back to AI to re-ask.
- Only a code-validated, normalized value is stored as collected and eligible for an API call.

Provenance guarantee: because extraction is separated from generation and only validated values are accepted, a hallucinated value either (a) is not in the patient's text so extract() won't produce it, or (b) fails code validation. The model cannot inject a fabricated field into a booking.

Ambiguity handling: if extraction is ambiguous (e.g. "09-06-1990" could be Jun 9 or Sep 6), code does NOT guess. It flags ambiguous → AI asks a clarifying question ("just to confirm, is that the 9th of June or the 6th of September?"). Never silently pick.

---

## 4. Deterministic pre-call gate (the enforcement core)

Before ANY API call that consumes collected data (primarily Acuity createAppointment, also GHL contact upsert), run a gate:

```
function gateApiCall(appointmentTypeId, collected):
  spec = fieldSpec[appointmentTypeId]  // or fetch+cache from Acuity if missing
  missing = []
  for field in spec.fields where requirement == "mandatory":
    value = collected[field.key]
    if value is absent OR not code-validated for field.type:
      missing.push(field)
  if missing.length > 0:
    return { ready: false, missing }  // DO NOT CALL API
  return { ready: true, payload: buildValidatedPayload(spec, collected) }  // only validated values
```

- ready=false → the flow sends back to the AI: "cannot complete the booking yet, still need: <missing labels>". The AI asks for them naturally. Loop until ready.
- ready=true → build the API payload from ONLY validated values (no defaults, no fabrication), make the call.
- post_booking fields are NOT gated for the booking call; they are collected/sent after, per Acuity's design.
- optional fields: included if present+valid, omitted if absent. Never defaulted.

This gate is the thing that makes skipping and hallucinating impossible: the AI cannot advance to a successful booking without the code confirming every mandatory field is real and valid.

---

## 5. API-error handling (check why, never blind-retry or fabricate)

On any API call:
- SUCCESS → proceed.
- ERROR → read the error body, diagnose:
  - 4xx validation error naming a field → map back to that field, mark it missing/invalid, loop to AI to re-collect ("that didn't go through, could you confirm your...").
  - auth/version/endpoint error → this is a config/code bug, surface to ops (Slack/log), do NOT retry blindly, do NOT fabricate to force success.
  - transient/5xx/network → bounded retry (already in Acuity client), then escalate if still failing.
- NEVER fabricate a field value to make a failing call succeed. NEVER blind-loop retries.

---

## 6. Webhook seeding (never re-ask known data)

At conversation start, parse the inbound webhook for already-known fields and seed collected:
- GHL/form/WA payloads carry first_name, last_name, full_name, phone, email when known. (Ignore "Guest Visitor" placeholder names, treat as unknown.)
- Seed only real values; validate them through the same code normalization (a webhook phone still gets normalized to +64).
- The AI then only asks for what is still genuinely missing for the chosen appointment type.

---

## 7. What stays (all existing guardrails)

- Fact injection (service/slot/confirmed), sanitizer, contact-info stripper, em-dash/semicolon/no-Hey rules, clinician-name strip, payment-held language, URL ban.
- The voice rewrite (warm, low-entry, patient-centric).
- Idempotency on Acuity and Stripe.
- Escalation (regex + model safety) → HUMAN_TOUCH.

---

## 8. Build order (deliberate, next session)

1. Make the per-type field spec explicit (mandatory/optional/post_booking + type), seeded from existing mapIntakeFields knowledge. Add Acuity /forms fetch as verify-fallback.
2. Remove all silent defaults from mapIntakeFields.
3. Add per-field-type validators/normalizers (date with ambiguity flag, NZ phone, email, enum).
4. Build the gateApiCall function + buildValidatedPayload (validated values only).
5. Rework the flow from rigid funnel to ENGAGING + intent-driven booking sub-phases.
6. Add webhook seeding of collected fields (+ ignore Guest Visitor).
7. Wire API-error diagnosis → field-level loopback.
8. Build test fixtures from REAL payloads + a full booking walk per appointment type, asserting: no field ever defaulted, gate blocks on missing mandatory, ambiguous DOB triggers clarification, known webhook fields never re-asked.

Each step verified from a clean clone of a pushed tag before the next. Contract tests against real/sandbox Acuity + GHL as a pre-deploy gate. Mocks must reject exactly what the real APIs reject.
