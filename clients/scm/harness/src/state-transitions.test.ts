import { describe, expect, it } from "vitest";
import { createEngine } from "@romea/state-machine";
import { createScmStateMachineConfig, type ScmContext } from "@romea/scm-flow";

function makeEngine() {
  return createEngine(createScmStateMachineConfig());
}

const emptyContext: ScmContext = {};

/**
 * Consolidated regression test: every edge in the SCM state machine.
 *
 * Coverage goal: for every state transition, prove valid input advances
 * and invalid input re-prompts.
 */
describe("SCM state machine — every edge", () => {
  /* ── Edge: NEW → COLLECTING_NAME ─────────────────────────────── */
  it("NEW → COLLECTING_NAME on any input", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "Hi",
      conversation: { currentState: "NEW", collected: {} },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_NAME");
    expect(result.rePrompt).toBe(false);
  });

  /* ── Edge: COLLECTING_NAME → COLLECTING_PHONE ────────────────── */
  it("COLLECTING_NAME → COLLECTING_PHONE on valid full name", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "John Smith",
      conversation: { currentState: "COLLECTING_NAME", collected: {} },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_PHONE");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.fullName).toBe("John Smith");
  });

  it("COLLECTING_NAME → COLLECTING_NAME on placeholder name", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "Guest Visitor",
      conversation: { currentState: "COLLECTING_NAME", collected: {} },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_NAME");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("placeholder_name");
  });

  it("COLLECTING_NAME → COLLECTING_NAME on single-word name", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "Tom",
      conversation: { currentState: "COLLECTING_NAME", collected: {} },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_NAME");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("first_last_required");
  });

  it("COLLECTING_NAME → COLLECTING_NAME on email-as-name", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "tom@example.com",
      conversation: { currentState: "COLLECTING_NAME", collected: {} },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_NAME");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("invalid_name");
  });

  /* ── Edge: COLLECTING_PHONE → COLLECTING_EMAIL ───────────────── */
  it("COLLECTING_PHONE → COLLECTING_EMAIL on valid +64 number", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "+64 21 000 0000",
      conversation: {
        currentState: "COLLECTING_PHONE",
        collected: { fullName: "John Smith" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_EMAIL");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.phone).toBe("+64210000000");
  });

  it("COLLECTING_PHONE → COLLECTING_PHONE on bare NZ number (no country)", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "0210000000",
      conversation: {
        currentState: "COLLECTING_PHONE",
        collected: { fullName: "John Smith" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_PHONE");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("no_country");
  });

  it("COLLECTING_PHONE → COLLECTING_PHONE on too-short number", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "123",
      conversation: {
        currentState: "COLLECTING_PHONE",
        collected: { fullName: "John Smith" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_PHONE");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("too_short");
  });

  it("COLLECTING_PHONE → COLLECTING_PHONE on invalid chars", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "+64abc12345",
      conversation: {
        currentState: "COLLECTING_PHONE",
        collected: { fullName: "John Smith" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_PHONE");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("invalid_chars");
  });

  /* ── Edge: COLLECTING_EMAIL → SELECTING_SERVICE ──────────────── */
  it("COLLECTING_EMAIL → SELECTING_SERVICE on valid email", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "john.smith@selfcaremen.co.nz",
      conversation: {
        currentState: "COLLECTING_EMAIL",
        collected: { fullName: "John Smith", phone: "+64210000000" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("SELECTING_SERVICE");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.email).toBe("john.smith@selfcaremen.co.nz");
  });

  it("COLLECTING_EMAIL → COLLECTING_EMAIL on invalid email format", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "not-an-email",
      conversation: {
        currentState: "COLLECTING_EMAIL",
        collected: { fullName: "John Smith", phone: "+64210000000" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_EMAIL");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("invalid_email");
  });

  it("COLLECTING_EMAIL → COLLECTING_EMAIL on fabricated domain", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "test@example.com",
      conversation: {
        currentState: "COLLECTING_EMAIL",
        collected: { fullName: "John Smith", phone: "+64210000000" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_EMAIL");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("fake_domain");
  });

  it("COLLECTING_EMAIL → COLLECTING_EMAIL when patient tries to skip ahead", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "I want to book free_eligibility now",
      conversation: {
        currentState: "COLLECTING_EMAIL",
        collected: { fullName: "John Smith", phone: "+64210000000" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("COLLECTING_EMAIL");
    expect(result.rePrompt).toBe(true);
  });

  /* ── Edge: SELECTING_SERVICE → SHOWING_SLOTS ─────────────────── */
  it("SELECTING_SERVICE → SHOWING_SLOTS on valid free service", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "free_eligibility",
      conversation: {
        currentState: "SELECTING_SERVICE",
        collected: {
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john@example.com",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("SHOWING_SLOTS");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.serviceKey).toMatchObject({ key: "free_eligibility", paid: false });
  });

  it("SELECTING_SERVICE → SHOWING_SLOTS on valid paid service", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "trt_initial",
      conversation: {
        currentState: "SELECTING_SERVICE",
        collected: {
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john@example.com",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("SHOWING_SLOTS");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.serviceKey).toMatchObject({ key: "trt_initial", paid: true });
  });

  it("SELECTING_SERVICE → SELECTING_SERVICE on deactivated vasectomy", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "vasectomy",
      conversation: {
        currentState: "SELECTING_SERVICE",
        collected: {
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john@example.com",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("SELECTING_SERVICE");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("service_unavailable");
  });

  it("SELECTING_SERVICE → SELECTING_SERVICE on unknown service", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "random_service",
      conversation: {
        currentState: "SELECTING_SERVICE",
        collected: {
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john@example.com",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("SELECTING_SERVICE");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("unknown_service");
  });

  /* ── Edge: SHOWING_SLOTS → AWAITING_SELECTION ────────────────── */
  it("SHOWING_SLOTS → AWAITING_SELECTION on any input", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "ok",
      conversation: {
        currentState: "SHOWING_SLOTS",
        collected: {
          fullName: "John Smith",
          serviceKey: "free_eligibility",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("AWAITING_SELECTION");
    expect(result.rePrompt).toBe(false);
  });

  /* ── Edge: AWAITING_SELECTION → BOOKING_ACUITY (free) ────────── */
  it("AWAITING_SELECTION → BOOKING_ACUITY on valid slot for free service", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "2026-06-20T09:00:00+12:00",
      conversation: {
        currentState: "AWAITING_SELECTION",
        collected: {
          fullName: "John Smith",
          serviceKey: "free_eligibility",
          slotMenu: [{ iso: "2026-06-20T09:00:00+12:00" }],
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("BOOKING_ACUITY");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.slotIso).toBe("2026-06-20T09:00:00+12:00");
  });

  /* ── Edge: AWAITING_SELECTION → CREATING_CHECKOUT (paid) ─────── */
  it("AWAITING_SELECTION → CREATING_CHECKOUT on valid slot for paid service", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "2026-06-20T10:00:00+12:00",
      conversation: {
        currentState: "AWAITING_SELECTION",
        collected: {
          fullName: "John Smith",
          serviceKey: "trt_initial",
          slotMenu: [{ iso: "2026-06-20T10:00:00+12:00" }],
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("CREATING_CHECKOUT");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.slotIso).toBe("2026-06-20T10:00:00+12:00");
  });

  it("AWAITING_SELECTION → AWAITING_SELECTION on invalid slot", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "2026-06-21T09:00:00+12:00",
      conversation: {
        currentState: "AWAITING_SELECTION",
        collected: {
          fullName: "John Smith",
          serviceKey: "free_eligibility",
          slotMenu: [{ iso: "2026-06-20T09:00:00+12:00" }],
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("AWAITING_SELECTION");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("invalid_slot");
  });

  /* ── Edge: CREATING_CHECKOUT → AWAITING_PAYMENT ──────────────── */
  it("CREATING_CHECKOUT → AWAITING_PAYMENT on any input", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "ok",
      conversation: {
        currentState: "CREATING_CHECKOUT",
        collected: {
          fullName: "John Smith",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T10:00:00+12:00",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("AWAITING_PAYMENT");
    expect(result.rePrompt).toBe(false);
  });

  /* ── Edge: AWAITING_PAYMENT → BOOKING_ACUITY (paid clears) ───── */
  it("AWAITING_PAYMENT → BOOKING_ACUITY when paymentReceived=true", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "paid",
      conversation: {
        currentState: "AWAITING_PAYMENT",
        collected: {
          fullName: "John Smith",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T10:00:00+12:00",
        },
      },
      context: { paymentReceived: true },
    });
    expect(result.state).toBe("BOOKING_ACUITY");
    expect(result.rePrompt).toBe(false);
  });

  it("AWAITING_PAYMENT → AWAITING_PAYMENT when paymentReceived=false", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "any update?",
      conversation: {
        currentState: "AWAITING_PAYMENT",
        collected: {
          fullName: "John Smith",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T10:00:00+12:00",
        },
      },
      context: { paymentReceived: false },
    });
    expect(result.state).toBe("AWAITING_PAYMENT");
    expect(result.rePrompt).toBe(false);
  });

  /* ── Edge: BOOKING_ACUITY → CONFIRMED ────────────────────────── */
  it("BOOKING_ACUITY → CONFIRMED on any input", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "confirm",
      conversation: {
        currentState: "BOOKING_ACUITY",
        collected: {
          fullName: "John Smith",
          serviceKey: "free_eligibility",
          slotIso: "2026-06-20T09:00:00+12:00",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("CONFIRMED");
    expect(result.rePrompt).toBe(false);
  });

  /* ── Edge: CONFIRMED → CONFIRMED (terminal) ──────────────────── */
  it("CONFIRMED → CONFIRMED (terminal state)", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "thanks",
      conversation: {
        currentState: "CONFIRMED",
        collected: {
          fullName: "John Smith",
          serviceKey: "free_eligibility",
          slotIso: "2026-06-20T09:00:00+12:00",
        },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("CONFIRMED");
    expect(result.rePrompt).toBe(false);
  });

  /* ── Full happy path: free service ───────────────────────────── */
  it("complete free booking walkthrough", async () => {
    const engine = makeEngine();

    const s1 = await engine.process({
      rawMessage: "Hi",
      conversation: { currentState: "NEW", collected: {} },
      context: emptyContext,
    });
    expect(s1.state).toBe("COLLECTING_NAME");

    const s2 = await engine.process({
      rawMessage: "John Smith",
      conversation: { currentState: s1.state, collected: s1.collected },
      context: emptyContext,
    });
    expect(s2.state).toBe("COLLECTING_PHONE");

    const s3 = await engine.process({
      rawMessage: "+64 21 000 0000",
      conversation: { currentState: s2.state, collected: s2.collected },
      context: emptyContext,
    });
    expect(s3.state).toBe("COLLECTING_EMAIL");

    const s4 = await engine.process({
      rawMessage: "john.smith@selfcaremen.co.nz",
      conversation: { currentState: s3.state, collected: s3.collected },
      context: emptyContext,
    });
    expect(s4.state).toBe("SELECTING_SERVICE");

    const s5 = await engine.process({
      rawMessage: "free_eligibility",
      conversation: { currentState: s4.state, collected: s4.collected },
      context: emptyContext,
    });
    expect(s5.state).toBe("SHOWING_SLOTS");

    const s6 = await engine.process({
      rawMessage: "ok",
      conversation: { currentState: s5.state, collected: s5.collected },
      context: emptyContext,
    });
    expect(s6.state).toBe("AWAITING_SELECTION");

    const s7 = await engine.process({
      rawMessage: "2026-06-20T09:00:00+12:00",
      conversation: {
        currentState: s6.state,
        collected: { ...s6.collected, slotMenu: [{ iso: "2026-06-20T09:00:00+12:00" }] },
      },
      context: emptyContext,
    });
    expect(s7.state).toBe("BOOKING_ACUITY");

    const s8 = await engine.process({
      rawMessage: "confirm",
      conversation: { currentState: s7.state, collected: s7.collected },
      context: emptyContext,
    });
    expect(s8.state).toBe("CONFIRMED");
  });

  /* ── Full happy path: paid service ───────────────────────────── */
  it("complete paid booking walkthrough", async () => {
    const engine = makeEngine();

    const collected = {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "john.smith@selfcaremen.co.nz",
      serviceKey: "trt_initial",
      slotMenu: [{ iso: "2026-06-20T10:00:00+12:00" }],
    };

    const s1 = await engine.process({
      rawMessage: "2026-06-20T10:00:00+12:00",
      conversation: { currentState: "AWAITING_SELECTION", collected },
      context: emptyContext,
    });
    expect(s1.state).toBe("CREATING_CHECKOUT");

    const s2 = await engine.process({
      rawMessage: "ok",
      conversation: { currentState: s1.state, collected: s1.collected },
      context: emptyContext,
    });
    expect(s2.state).toBe("AWAITING_PAYMENT");

    const s3 = await engine.process({
      rawMessage: "paid",
      conversation: { currentState: s2.state, collected: s2.collected },
      context: { paymentReceived: true },
    });
    expect(s3.state).toBe("BOOKING_ACUITY");

    const s4 = await engine.process({
      rawMessage: "confirm",
      conversation: { currentState: s3.state, collected: s3.collected },
      context: emptyContext,
    });
    expect(s4.state).toBe("CONFIRMED");
  });
});
