import { describe, expect, it } from "vitest";
import { generate, createRouter, sanitizeOutput } from "@romea/scm-flow";
import { loadConfig } from "@romea/model-router";
import type { ScmCollected, ScmState } from "@romea/scm-flow";

const longTimeout = 30000;

function makeRouter(overrides?: Record<string, string>) {
  const cfg = loadConfig();
  return createRouter({
    ...cfg,
    ...(overrides ?? {}),
  } as ReturnType<typeof loadConfig>);
}

function lintMessage(text: string): string[] {
  const issues: string[] = [];
  const trimmed = text.trim();
  const firstSentence = trimmed.split(/[.!?\n]/)[0] ?? "";

  if (text.includes("—") || /\b--\b/.test(text)) {
    issues.push("contains em dash");
  }
  if (/^(hey|hey there)\b/i.test(trimmed)) {
    issues.push("opens with Hey/Hey there");
  }
  if (/!/.test(firstSentence)) {
    issues.push("exclamation point in opening line");
  }
  if (/;/.test(text)) {
    issues.push("contains semicolon");
  }

  return issues;
}

function assertHeldLanguage(text: string): string[] {
  const issues: string[] = [];
  const lower = text.toLowerCase();
  if (!lower.includes("held") && !lower.includes("on hold")) {
    issues.push("missing 'held' or 'on hold'");
  }
  return issues;
}

const testStates: Array<{ state: ScmState; collected: ScmCollected; errorKey?: string }> = [
  { state: "NEW", collected: {} },
  { state: "ENGAGING", collected: {} },
  { state: "COLLECTING", collected: { fullName: "John Smith", phone: "+64210000000", email: "john@example.com", missingFields: ["dob"] } },
  { state: "SELECTING_SERVICE", collected: { fullName: "John Smith", phone: "+64210000000", email: "john@example.com" } },
  { state: "SHOWING_SLOTS", collected: { fullName: "John Smith", serviceKey: "trt_initial" } },
  { state: "AWAITING_SELECTION", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotMenu: [{ iso: "2026-06-20T09:00:00+12:00" }] } },
  { state: "CREATING_CHECKOUT", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" } },
  { state: "AWAITING_PAYMENT", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" } },
  { state: "CONFIRMED", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" } },
];

/**
 * Consolidated regression test: style rules and held language.
 *
 * For each model (primary Sonnet + fallback GLM-5.1):
 * - Generate messages across all states
 * - Assert no em dashes, no "Hey" opener, no opening exclamation, no semicolons
 * - Assert pre-payment states use "held" / "on hold" language
 * - Warn (but allow) future/conditional clauses with commitment words
 */
describe("style rules — primary model (Sonnet)", () => {
  it(
    "passes style lint across all states",
    async () => {
      const router = makeRouter({
        generateModel: "anth_api/claude-sonnet-4-6",
        generateFallbackModel: "anth_api/claude-sonnet-4-6",
      });

      const results = await Promise.all(
        testStates.map(async ({ state, collected }) => {
          const text = await generate(state, collected, [], undefined, undefined, { router });
          return { state, issues: lintMessage(text), text };
        }),
      );

      const failures = results.filter((r) => r.issues.length > 0);
      if (failures.length > 0) {
        console.error("Style failures:", failures.map((f) => ({ state: f.state, issues: f.issues, text: f.text.slice(0, 120) })));
      }
      expect(failures).toEqual([]);
    },
    longTimeout * 2,
  );

  it(
    "AWAITING_PAYMENT uses held language",
    async () => {
      const router = makeRouter({
        generateModel: "anth_api/claude-sonnet-4-6",
        generateFallbackModel: "anth_api/claude-sonnet-4-6",
      });
      const text = await generate(
        "AWAITING_PAYMENT",
        { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" },
        [],
        undefined,
        undefined,
        { router },
      );
      console.log("Sonnet AWAITING_PAYMENT:", text);
      expect(assertHeldLanguage(text)).toEqual([]);
    },
    longTimeout,
  );

  it(
    "CREATING_CHECKOUT uses held language",
    async () => {
      const router = makeRouter({
        generateModel: "anth_api/claude-sonnet-4-6",
        generateFallbackModel: "anth_api/claude-sonnet-4-6",
      });
      const text = await generate(
        "CREATING_CHECKOUT",
        { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" },
        [],
        undefined,
        undefined,
        { router },
      );
      console.log("Sonnet CREATING_CHECKOUT:", text);
      expect(assertHeldLanguage(text)).toEqual([]);
    },
    longTimeout,
  );
});

describe("style rules — fallback model (GLM-5.1)", () => {
  it(
    "passes style lint across all states",
    async () => {
      const router = makeRouter({
        generateModel: "dash_intl/glm-5.1",
        generateFallbackModel: "dash_intl/glm-5.1",
      });
      const results: Array<{ state: ScmState; issues: string[]; text: string }> = [];

      for (const { state, collected } of testStates) {
        const text = await generate(state, collected, [], undefined, undefined, { router });
        results.push({ state, issues: lintMessage(text), text });
      }

      const failures = results.filter((r) => r.issues.length > 0);
      if (failures.length > 0) {
        console.error("GLM-5.1 style failures:", failures.map((f) => ({ state: f.state, issues: f.issues, text: f.text.slice(0, 120) })));
      }
      expect(failures).toEqual([]);
    },
    longTimeout * 6,
  );

  it(
    "AWAITING_PAYMENT uses held language",
    async () => {
      const router = makeRouter({
        generateModel: "dash_intl/glm-5.1",
        generateFallbackModel: "dash_intl/glm-5.1",
      });
      const text = await generate(
        "AWAITING_PAYMENT",
        { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" },
        [],
        undefined,
        undefined,
        { router },
      );
      console.log("GLM-5.1 AWAITING_PAYMENT:", text);
      expect(assertHeldLanguage(text)).toEqual([]);
    },
    360000,
  );

  it(
    "CREATING_CHECKOUT uses held language",
    async () => {
      const router = makeRouter({
        generateModel: "dash_intl/glm-5.1",
        generateFallbackModel: "dash_intl/glm-5.1",
      });
      const text = await generate(
        "CREATING_CHECKOUT",
        { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" },
        [],
        undefined,
        undefined,
        { router },
      );
      console.log("GLM-5.1 CREATING_CHECKOUT:", text);
      expect(assertHeldLanguage(text)).toEqual([]);
    },
    360000,
  );
});

describe("held language — no present-tense commitment in pre-payment", () => {
  it("future/conditional 'will be confirmed' is allowed in AWAITING_PAYMENT", () => {
    const text = "Your slot will be confirmed once payment clears.";
    const result = sanitizeOutput(text, "AWAITING_PAYMENT");
    expect(result).toBe(text);
  });

  it("future/conditional 'will be scheduled' is allowed in CREATING_CHECKOUT", () => {
    const text = "Your appointment will be scheduled after the deposit is received.";
    const result = sanitizeOutput(text, "CREATING_CHECKOUT");
    expect(result).toBe(text);
  });

  it("present-tense 'is confirmed' in CONFIRMED is allowed", () => {
    const text = "Your appointment is confirmed.";
    const result = sanitizeOutput(text, "CONFIRMED");
    expect(result).toBe(text);
  });
});
