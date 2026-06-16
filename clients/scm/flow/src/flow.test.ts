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
    expect(afterWelcome.state).toBe("COLLECTING_NAME");

    const afterName = await engine.process({
      rawMessage: "John Smith",
      conversation: { currentState: afterWelcome.state, collected: afterWelcome.collected },
      context: emptyContext,
    });
    expect(afterName.state).toBe("COLLECTING_PHONE");
    expect(afterName.collected.fullName).toBe("John Smith");

    const afterPhone = await engine.process({
      rawMessage: "+64 21 000 0000",
      conversation: { currentState: afterName.state, collected: afterName.collected },
      context: emptyContext,
    });
    expect(afterPhone.state).toBe("COLLECTING_EMAIL");
    expect(afterPhone.collected.phone).toBe("+64210000000");

    const afterEmail = await engine.process({
      rawMessage: "john.smith@selfcaremen.co.nz",
      conversation: { currentState: afterPhone.state, collected: afterPhone.collected },
      context: emptyContext,
    });
    expect(afterEmail.state).toBe("SELECTING_SERVICE");
    expect(afterEmail.collected.email).toBe("john.smith@selfcaremen.co.nz");

    const afterService = await engine.process({
      rawMessage: "free_eligibility",
      conversation: { currentState: afterEmail.state, collected: afterEmail.collected },
      context: emptyContext,
    });
    expect(afterService.state).toBe("SHOWING_SLOTS");
    expect(afterService.collected.serviceKey).toMatchObject({
      key: "free_eligibility",
      paid: false,
    });

    const afterShowSlots = await engine.process({
      rawMessage: "ok",
      conversation: { currentState: afterService.state, collected: afterService.collected },
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
      serviceKey: "trt_initial",
      slotMenu: [{ iso: "2026-06-20T10:00:00+12:00" }],
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

describe("SCM flow failure paths", () => {
  it("stays in COLLECTING_EMAIL on invalid email", async () => {
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
    expect(result.collected).toEqual({
      fullName: "John Smith",
      phone: "+64210000000",
    });
  });

  it("stays in COLLECTING_NAME on placeholder name", async () => {
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

  it("cannot skip from COLLECTING_EMAIL to CONFIRMED", async () => {
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

  it("stays in AWAITING_PAYMENT until payment webhook context arrives", async () => {
    const engine = makeEngine();

    const collected = {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "john.smith@selfcaremen.co.nz",
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
