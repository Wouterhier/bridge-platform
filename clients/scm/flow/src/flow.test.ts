import { describe, expect, it } from "vitest";
import { createEngine } from "@romea/state-machine";
import { createScmStateMachineConfig, type ScmContext } from "./states.js";

function makeEngine() {
  return createEngine(createScmStateMachineConfig());
}

const emptyContext: ScmContext = {};

describe("SCM flow happy path", () => {
  it("books a free eligibility appointment end to end", async () => {
    const engine = makeEngine();

    const afterWelcome = await engine.process({
      rawMessage: "Hi",
      conversation: { currentState: "NEW", collected: {} },
      context: emptyContext,
    });
    expect(afterWelcome.state).toBe("ENGAGING");

    const afterEngaging = await engine.process({
      rawMessage: "I want to book a free eligibility check",
      conversation: { currentState: afterWelcome.state, collected: { ...afterWelcome.collected, bookingIntent: true } },
      context: emptyContext,
    });
    expect(afterEngaging.state).toBe("SELECTING_SERVICE");

    const afterService = await engine.process({
      rawMessage: "free_eligibility",
      conversation: { currentState: afterEngaging.state, collected: afterEngaging.collected },
      context: emptyContext,
    });
    expect(afterService.state).toBe("COLLECTING");

    // COLLECTING with all mandatory fields present → SHOWING_SLOTS
    const afterCollecting = await engine.process({
      rawMessage: "ok",
      conversation: {
        currentState: afterService.state,
        collected: {
          ...afterService.collected,
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john.smith@selfcaremen.co.nz",
          dob: "07/26/1995",
          missingFields: [],
        },
      },
      context: emptyContext,
    });
    expect(afterCollecting.state).toBe("SHOWING_SLOTS");

    const afterShowSlots = await engine.process({
      rawMessage: "ok",
      conversation: { currentState: afterCollecting.state, collected: afterCollecting.collected },
      context: emptyContext,
    });
    expect(afterShowSlots.state).toBe("AWAITING_SELECTION");

    const slotMenu = [{ iso: "2026-06-20T09:00:00+12:00" }];
    const afterSlot = await engine.process({
      rawMessage: "2026-06-20T09:00:00+12:00",
      conversation: {
        currentState: afterShowSlots.state,
        collected: { ...afterShowSlots.collected, slotMenu },
      },
      context: emptyContext,
    });
    expect(afterSlot.state).toBe("BOOKING_ACUITY");
    expect(afterSlot.collected.slotIso).toBe("2026-06-20T09:00:00+12:00");

    const afterBook = await engine.process({
      rawMessage: "confirm",
      conversation: { currentState: afterSlot.state, collected: afterSlot.collected },
      context: emptyContext,
    });
    expect(afterBook.state).toBe("CONFIRMED");
  });

  it("creates checkout for a paid service and completes after payment", async () => {
    const engine = makeEngine();

    const collected = {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "john.smith@selfcaremen.co.nz",
      dob: "07/26/1995",
      serviceKey: "trt_initial",
      slotMenu: [{ iso: "2026-06-20T10:00:00+12:00" }],
      missingFields: [],
    };

    const afterSlot = await engine.process({
      rawMessage: "2026-06-20T10:00:00+12:00",
      conversation: { currentState: "AWAITING_SELECTION", collected },
      context: emptyContext,
    });
    expect(afterSlot.state).toBe("CREATING_CHECKOUT");
    expect(afterSlot.collected.slotIso).toBe("2026-06-20T10:00:00+12:00");

    const afterCheckout = await engine.process({
      rawMessage: "ok",
      conversation: { currentState: afterSlot.state, collected: afterSlot.collected },
      context: emptyContext,
    });
    expect(afterCheckout.state).toBe("AWAITING_PAYMENT");

    const afterPending = await engine.process({
      rawMessage: "paid",
      conversation: { currentState: afterCheckout.state, collected: afterCheckout.collected },
      context: { paymentReceived: true },
    });
    expect(afterPending.state).toBe("BOOKING_ACUITY");

    const afterBook = await engine.process({
      rawMessage: "confirm",
      conversation: { currentState: afterPending.state, collected: afterPending.collected },
      context: emptyContext,
    });
    expect(afterBook.state).toBe("CONFIRMED");
  });
});

describe("webhook seeding", () => {
  it("ENGAGING prompt does not re-ask for name/phone when seeded", async () => {
    const engine = makeEngine();
    const result = await engine.process({
      rawMessage: "Hi",
      conversation: {
        currentState: "ENGAGING",
        collected: { fullName: "Jane Doe", phone: "+6421234567" },
      },
      context: emptyContext,
    });
    expect(result.state).toBe("ENGAGING");

    // Build prompt context should not ask for name or phone
    const config = createScmStateMachineConfig();
    const ctx = config.states.ENGAGING.buildPromptContext(
      { fullName: "Jane Doe", phone: "+6421234567" } as Record<string, unknown>,
      emptyContext,
    );
    const lower = ctx.toLowerCase();
    expect(lower).not.toContain("what's your name");
    expect(lower).not.toContain("your name");
    expect(lower).not.toContain("phone number");
  });
});

describe("SCM flow failure paths", () => {
  it("stays in ENGAGING without booking intent", async () => {
    const engine = makeEngine();

    const result = await engine.process({
      rawMessage: "Just looking around",
      conversation: { currentState: "ENGAGING", collected: {} },
      context: emptyContext,
    });

    expect(result.state).toBe("ENGAGING");
    expect(result.rePrompt).toBe(false);
  });

  it("stays in COLLECTING when mandatory fields are missing", async () => {
    const engine = makeEngine();

    const result = await engine.process({
      rawMessage: "I want to book",
      conversation: {
        currentState: "COLLECTING",
        collected: {
          serviceKey: "free_eligibility",
          fullName: "John Smith",
          // phone, email, dob missing
          missingFields: ["phone", "email", "dob"],
        },
      },
      context: emptyContext,
    });

    expect(result.state).toBe("COLLECTING");
    expect(result.rePrompt).toBe(false);
  });

  it("cannot skip from COLLECTING to CONFIRMED", async () => {
    const engine = makeEngine();

    const result = await engine.process({
      rawMessage: "confirm my booking now",
      conversation: {
        currentState: "COLLECTING",
        collected: {
          fullName: "John Smith",
          phone: "+64210000000",
          serviceKey: "free_eligibility",
          missingFields: ["email", "dob"],
        },
      },
      context: emptyContext,
    });

    expect(result.state).toBe("COLLECTING");
  });

  it("stays in AWAITING_PAYMENT until payment webhook context arrives", async () => {
    const engine = makeEngine();

    const collected = {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "john.smith@selfcaremen.co.nz",
      dob: "07/26/1995",
      serviceKey: "trt_initial",
      slotIso: "2026-06-20T10:00:00+12:00",
    };

    const result = await engine.process({
      rawMessage: "any update?",
      conversation: { currentState: "AWAITING_PAYMENT", collected },
      context: { paymentReceived: false },
    });

    expect(result.state).toBe("AWAITING_PAYMENT");
    expect(result.rePrompt).toBe(false);
  });
});
