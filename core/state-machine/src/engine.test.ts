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
});
