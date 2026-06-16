import { describe, expect, it } from "vitest";
import { createEngine } from "./engine.js";
import type { StateMachineConfig } from "./types.js";

type State = "ASK_AGE" | "ASK_EMAIL" | "DONE";
type Field = "age" | "email";
type Context = { tenant: string };

function makeConfig(): StateMachineConfig<State, Field, Context> {
  return {
    initialState: "ASK_AGE",
    states: {
      ASK_AGE: {
        id: "ASK_AGE",
        requiredField: "age",
        validate: (raw) => {
          const n = Number(raw.trim());
          if (!Number.isFinite(n) || !Number.isInteger(n)) {
            return { ok: false, error: "INVALID_AGE_FORMAT" };
          }
          if (n < 0 || n > 120) {
            return { ok: false, error: "AGE_OUT_OF_RANGE" };
          }
          return { ok: true, value: n };
        },
        next: () => "ASK_EMAIL",
        buildPromptContext: (collected) =>
          `Ask for the user's age. Collected: ${JSON.stringify(collected)}`,
      },
      ASK_EMAIL: {
        id: "ASK_EMAIL",
        requiredField: "email",
        validate: (raw) => {
          const email = raw.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return { ok: false, error: "INVALID_EMAIL" };
          }
          return { ok: true, value: email };
        },
        next: () => "DONE",
        buildPromptContext: (collected) =>
          `Ask for the user's email. Age collected: ${collected.age}`,
      },
      DONE: {
        id: "DONE",
        validate: () => ({ ok: true }),
        next: () => "DONE",
        buildPromptContext: (collected) =>
          `All done. Collected: ${JSON.stringify(collected)}`,
      },
    },
  };
}

describe("createEngine", () => {
  it("starts in ASK_AGE", () => {
    const engine = createEngine(makeConfig());
    const state = engine.getCurrentState({
      currentState: "ASK_AGE",
      collected: {},
    });
    expect(state).toBe("ASK_AGE");
  });

  it("stays in ASK_AGE on non-numeric input", async () => {
    const engine = createEngine(makeConfig());
    const result = await engine.process({
      rawMessage: "abc",
      conversation: { currentState: "ASK_AGE", collected: {} },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("ASK_AGE");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("INVALID_AGE_FORMAT");
    expect(result.collected).toEqual({});
  });

  it("stays in ASK_AGE on out-of-range age", async () => {
    const engine = createEngine(makeConfig());
    const result = await engine.process({
      rawMessage: "150",
      conversation: { currentState: "ASK_AGE", collected: {} },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("ASK_AGE");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("AGE_OUT_OF_RANGE");
  });

  it("advances to ASK_EMAIL and stores age on valid input", async () => {
    const engine = createEngine(makeConfig());
    const result = await engine.process({
      rawMessage: "30",
      conversation: { currentState: "ASK_AGE", collected: {} },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("ASK_EMAIL");
    expect(result.rePrompt).toBe(false);
    expect(result.collected).toEqual({ age: 30 });
    expect(result.missingField).toBe("email");
  });

  it("stays in ASK_EMAIL on invalid email", async () => {
    const engine = createEngine(makeConfig());
    const result = await engine.process({
      rawMessage: "not-an-email",
      conversation: { currentState: "ASK_EMAIL", collected: { age: 30 } },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("ASK_EMAIL");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("INVALID_EMAIL");
    expect(result.collected).toEqual({ age: 30 });
  });

  it("advances to DONE on valid email", async () => {
    const engine = createEngine(makeConfig());
    const result = await engine.process({
      rawMessage: "test@example.com",
      conversation: { currentState: "ASK_EMAIL", collected: { age: 30 } },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("DONE");
    expect(result.rePrompt).toBe(false);
    expect(result.collected).toEqual({ age: 30, email: "test@example.com" });
  });

  it("persists collected fields across transitions", async () => {
    const engine = createEngine(makeConfig());
    const first = await engine.process({
      rawMessage: "30",
      conversation: { currentState: "ASK_AGE", collected: {} },
      context: { tenant: "test" },
    });
    const second = await engine.process({
      rawMessage: "test@example.com",
      conversation: { currentState: first.state, collected: first.collected },
      context: { tenant: "test" },
    });
    expect(second.state).toBe("DONE");
    expect(second.collected).toEqual({ age: 30, email: "test@example.com" });
  });

  it("advances automatically when a state has no requiredField", async () => {
    const config: StateMachineConfig<"START" | "END", never, Context> = {
      initialState: "START",
      states: {
        START: {
          id: "START",
          validate: () => ({ ok: true }),
          next: () => "END",
          buildPromptContext: () => "Starting...",
        },
        END: {
          id: "END",
          validate: () => ({ ok: true }),
          next: () => "END",
          buildPromptContext: () => "Finished.",
        },
      },
    };
    const engine = createEngine(config);
    const result = await engine.process({
      rawMessage: "hello",
      conversation: { currentState: "START", collected: {} },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("END");
    expect(result.rePrompt).toBe(false);
  });

  it("persists the validator's normalized output, not the raw extraction", async () => {
    type PhoneState = "COLLECT_PHONE" | "DONE";
    type PhoneField = "phone";
    const config: StateMachineConfig<PhoneState, PhoneField, Context> = {
      initialState: "COLLECT_PHONE",
      states: {
        COLLECT_PHONE: {
          id: "COLLECT_PHONE",
          requiredField: "phone",
          validate: (raw) => {
            let digits = raw.replace(/\D/g, "");
            if (digits.length < 8) {
              return { ok: false, error: "INVALID_PHONE" };
            }
            if (digits.startsWith("00")) {
              digits = digits.slice(2);
            } else if (digits.startsWith("0")) {
              digits = "64" + digits.slice(1);
            }
            const normalized = digits.startsWith("+")
              ? digits
              : `+${digits.slice(0, 10)}`;
            return { ok: true, value: normalized };
          },
          next: () => "DONE",
          buildPromptContext: () => "Ask for phone",
        },
        DONE: {
          id: "DONE",
          validate: () => ({ ok: true }),
          next: () => "DONE",
          buildPromptContext: () => "Finished",
        },
      },
    };
    const engine = createEngine(config);
    const result = await engine.process({
      rawMessage: "021 000 0000",
      conversation: { currentState: "COLLECT_PHONE", collected: {} },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("DONE");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.phone).toBe("+6421000000");
  });

  it("does not skip states when payload contains extra intent", async () => {
    type BookingState = "COLLECTING_EMAIL" | "SELECTING_SERVICE" | "CONFIRMED";
    type BookingField = "email";
    const config: StateMachineConfig<BookingState, BookingField, Context> = {
      initialState: "COLLECTING_EMAIL",
      states: {
        COLLECTING_EMAIL: {
          id: "COLLECTING_EMAIL",
          requiredField: "email",
          validate: (raw) => {
            const match = raw.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
            if (!match) {
              return { ok: false, error: "INVALID_EMAIL" };
            }
            return { ok: true, value: match[0] };
          },
          next: () => "SELECTING_SERVICE",
          buildPromptContext: () => "Ask for email",
        },
        SELECTING_SERVICE: {
          id: "SELECTING_SERVICE",
          validate: () => ({ ok: true }),
          next: () => "CONFIRMED",
          buildPromptContext: () => "Ask for service",
        },
        CONFIRMED: {
          id: "CONFIRMED",
          validate: () => ({ ok: true }),
          next: () => "CONFIRMED",
          buildPromptContext: () => "Confirmed",
        },
      },
    };
    const engine = createEngine(config);
    const result = await engine.process({
      rawMessage: "test@example.com I want to book now",
      conversation: { currentState: "COLLECTING_EMAIL", collected: {} },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("SELECTING_SERVICE");
    expect(result.rePrompt).toBe(false);
    expect(result.collected.email).toBe("test@example.com");
  });

  it("re-prompts on empty input and does not write a partial field", async () => {
    type NameState = "ASK_NAME" | "DONE";
    type NameField = "name";
    const config: StateMachineConfig<NameState, NameField, Context> = {
      initialState: "ASK_NAME",
      states: {
        ASK_NAME: {
          id: "ASK_NAME",
          requiredField: "name",
          validate: (raw) => {
            const trimmed = raw.trim();
            if (trimmed.length === 0) {
              return { ok: false, error: "NAME_REQUIRED" };
            }
            return { ok: true, value: trimmed };
          },
          next: () => "DONE",
          buildPromptContext: () => "Ask for name",
        },
        DONE: {
          id: "DONE",
          validate: () => ({ ok: true }),
          next: () => "DONE",
          buildPromptContext: () => "Finished",
        },
      },
    };
    const engine = createEngine(config);
    const result = await engine.process({
      rawMessage: "",
      conversation: { currentState: "ASK_NAME", collected: {} },
      context: { tenant: "test" },
    });
    expect(result.state).toBe("ASK_NAME");
    expect(result.rePrompt).toBe(true);
    expect(result.validationError).toBe("NAME_REQUIRED");
    expect(result.collected).toEqual({});
  });
});
