import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generate } from "./generate.js";
import { createRouter } from "./model-router-factory.js";
import { loadConfig, type ModelRequest } from "@romea/model-router";
import type { ScmCollected, ScmState } from "./states.js";

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

const testStates: Array<{ state: ScmState; collected: ScmCollected; errorKey?: string }> = [
  { state: "NEW", collected: {} },
  { state: "COLLECTING_NAME", collected: {} },
  { state: "COLLECTING_PHONE", collected: { fullName: "John Smith" } },
  { state: "COLLECTING_EMAIL", collected: { fullName: "John Smith", phone: "+64210000000" } },
  { state: "SELECTING_SERVICE", collected: { fullName: "John Smith", phone: "+64210000000", email: "john@example.com" } },
  { state: "SHOWING_SLOTS", collected: { fullName: "John Smith", serviceKey: "trt_initial" } },
  { state: "AWAITING_SELECTION", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotMenu: [{ iso: "2026-06-20T09:00:00+12:00" }] } },
  { state: "CREATING_CHECKOUT", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" } },
  { state: "AWAITING_PAYMENT", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" } },
  { state: "CONFIRMED", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-20T09:00:00+12:00" } },
];

describe("generate() returns prose only", () => {
  it.each(testStates)(
    "returns non-empty string for state $state",
    async ({ state, collected }) => {
      const router = makeRouter();
      const text = await generate(state, collected, [], undefined, undefined, { router });
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("```");
      expect(text).not.toContain('"role"');
    },
    longTimeout,
  );
});

describe("generate() fallback path", () => {
  it(
    "returns templated fallback when both primary and fallback models fail",
    async () => {
      const cfg = loadConfig();
      const brokenRouter = createRouter({
        ...cfg,
        generateModel: "google/broken-model",
        generateFallbackModel: "moon_api/broken-model",
        googleBaseUrl: "http://localhost:1",
        moonshotBaseUrl: "http://localhost:1",
      } as ReturnType<typeof loadConfig>);

      const text = await generate(
        "COLLECTING_NAME",
        {},
        [],
        undefined,
        undefined,
        { router: brokenRouter },
      );
      expect(text).toContain("full name");
    },
    longTimeout,
  );
});

describe("generate() style lint", () => {
  it(
    "primary model passes style rules across 10 states",
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
      expect(failures).toEqual([]);
    },
    longTimeout * 2,
  );

  it(
    "fallback model passes style rules across 10 states",
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
      expect(failures).toEqual([]);
    },
    longTimeout * 6,
  );
});

describe("generate() cache billing", () => {
  it(
    "second identical Anthropic generate call bills fewer input tokens via cache read",
    async () => {
      const router = makeRouter({
        generateModel: "anth_api/claude-sonnet-4-6",
        generateFallbackModel: "anth_api/claude-sonnet-4-6",
      });

      const kb = readFileSync(
        resolve(process.cwd(), "clients/scm/kb/knowledge-base.md"),
        "utf-8",
      );
      const system = [
        "You are a senior patient coordinator at a top-tier men's telehealth clinic.",
        "Be calm, precise, and warm. Never use em dashes. Never open with Hey. No exclamation points in opening lines. No semicolons.",
        "",
        "## Knowledge base",
        kb,
      ].join("\n");

      const req: ModelRequest = {
        role: "generate",
        system,
        messages: [
          { role: "user", content: "Ask a patient for their full name." },
        ],
        temperature: 0.7,
        maxTokens: 256,
      };

      const first = await router.complete("generate", req);
      const second = await router.complete("generate", req);

      console.log("First call usage:", first.usage);
      console.log("Second call usage:", second.usage);

      expect(first.usage?.promptTokens).toBeGreaterThan(0);
      expect(second.usage?.promptTokens).toBeGreaterThan(0);
      expect(second.usage?.cacheReadTokens ?? 0).toBeGreaterThan(0);
      expect(second.usage?.cacheWriteTokens ?? 0).toBe(0);
      // Anthropic bills cached input as cacheReadTokens, not promptTokens,
      // so the second call's promptTokens stays low while cacheReadTokens covers the cached system prompt.
    },
    longTimeout,
  );
});
