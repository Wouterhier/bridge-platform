import { describe, expect, it, vi } from "vitest";
import { createEngine } from "./engine.js";
import { runTurn } from "./extract-hook.js";
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
        buildPromptContext: () => "Ask for age.",
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
        buildPromptContext: () => "Ask for email.",
      },
      DONE: {
        id: "DONE",
        validate: () => ({ ok: true }),
        next: () => "DONE",
        buildPromptContext: () => "Done.",
      },
    },
  };
}

describe("runTurn", () => {
  it("deduplicates already-processed messages", async () => {
    const engine = createEngine(makeConfig());
    const extractFn = vi.fn();
    const generateFn = vi.fn();
    const deps = { db: { processed_messages: ["msg-1"] } };

    const result = await runTurn(
      engine,
      extractFn,
      generateFn,
      deps,
      {
        id: "msg-1",
        rawMessage: "30",
        conversation: { currentState: "ASK_AGE", collected: {} },
        context: { tenant: "test" },
      },
    );

    expect(result.alreadyProcessed).toBe(true);
    expect(result.state).toBe("ASK_AGE");
    expect(extractFn).not.toHaveBeenCalled();
    expect(generateFn).not.toHaveBeenCalled();
  });

  it("calls generateFn on re-prompt", async () => {
    const engine = createEngine(makeConfig());
    const extractFn = vi.fn();
    const generateFn = vi.fn().mockResolvedValue("Please provide a valid age.");
    const deps = { db: { processed_messages: [] } };

    const result = await runTurn(
      engine,
      extractFn,
      generateFn,
      deps,
      {
        id: "msg-1",
        rawMessage: "abc",
        conversation: { currentState: "ASK_AGE", collected: {} },
        context: { tenant: "test" },
      },
    );

    expect(result.rePrompt).toBe(true);
    expect(result.state).toBe("ASK_AGE");
    expect(result.validationError).toBe("INVALID_AGE_FORMAT");
    expect(result.reply).toBe("Please provide a valid age.");
    expect(generateFn).toHaveBeenCalledWith(
      "ASK_AGE",
      "Ask for age.",
      "INVALID_AGE_FORMAT",
    );
    expect(extractFn).not.toHaveBeenCalled();
  });

  it("calls extractFn when state advances to a field-collecting state", async () => {
    const engine = createEngine(makeConfig());
    const extractFn = vi.fn().mockResolvedValue({ email: "test@example.com" });
    const generateFn = vi.fn();
    const deps = { db: { processed_messages: [] } };

    const result = await runTurn(
      engine,
      extractFn,
      generateFn,
      deps,
      {
        id: "msg-1",
        rawMessage: "30",
        conversation: { currentState: "ASK_AGE", collected: {} },
        context: { tenant: "test" },
      },
    );

    expect(result.state).toBe("ASK_EMAIL");
    expect(result.rePrompt).toBe(false);
    expect(result.missingField).toBe("email");
    expect(extractFn).toHaveBeenCalledWith(
      "30",
      "email",
      "Ask for email.",
    );
    expect(result.extraction).toEqual({ email: "test@example.com" });
    expect(generateFn).not.toHaveBeenCalled();
  });
});
