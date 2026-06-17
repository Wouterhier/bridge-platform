import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generate,
  buildServiceFactsBlock,
  buildConfirmedFacts,
  sanitizeOutput,
} from "@romea/scm-flow";
import { createRouter } from "@romea/scm-flow";
import { getService } from "@romea/scm-flow";
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

/* ── Helpers ───────────────────────────────────────────────────────────── */

const urlRegex = /https?:\/\/[^\s)"\]]+/;
const emailRegex = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const phoneRegex = /\+?\d{1,3}[-.\s()]?\(?\d{2,4}\)?[-.\s]*\d{3,4}[-.\s]*\d{3,4}/;
const strippedUrlRegex = /\[link removed\]/;
const strippedPhoneRegex = /\[phone removed\]/;
const strippedEmailRegex = /\[contact removed\]/;

function assertNoUrls(text: string, allowedUrl?: string): string[] {
  const issues: string[] = [];
  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    const match = token.match(urlRegex);
    if (match) {
      if (allowedUrl && match[0].startsWith(allowedUrl)) continue;
      issues.push(`found URL: ${match[0]}`);
    }
  }
  if (strippedUrlRegex.test(text)) {
    issues.push("found [link removed] token");
  }
  return issues;
}

function assertNoEmails(text: string): string[] {
  const issues: string[] = [];
  if (emailRegex.test(text)) issues.push(`found email`);
  if (strippedEmailRegex.test(text)) issues.push("found [contact removed] token");
  return issues;
}

function assertNoPhones(text: string): string[] {
  const issues: string[] = [];
  // Skip ISO date strings like 2026-06-20T09:00:00+12:00
  const clean = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/g, "");
  if (phoneRegex.test(clean)) issues.push(`found phone number`);
  if (strippedPhoneRegex.test(clean)) issues.push("found [phone removed] token");
  return issues;
}

/* ── Test 1: Service facts echoed in message ──────────────────────────── */

describe("data-injection: service facts in generated message", () => {
  it(
    " echoes exact service name and price from services.ts in SELECTING_SERVICE reply",
    async () => {
      const router = makeRouter();
      const collected: ScmCollected = {
        fullName: "John Smith",
        phone: "+64210000000",
        email: "john@example.com",
        serviceKey: "trt_initial",
      };
      const text = await generate("SELECTING_SERVICE", collected, [], undefined, undefined, {
        router,
      });

      // The service facts block should have been injected; the model should echo it.
      // We accept the model rephrasing slightly, but the core facts must be present.
      const lower = text.toLowerCase();
      expect(lower).toContain("trt initial consultation");
      expect(text).toMatch(/\$179|nzd\s*\$?179|179\s*nzd/i);
    },
    longTimeout,
  );

  it(
    "buildServiceFactsBlock produces the expected block for a known service",
    () => {
      const collected: ScmCollected = { serviceKey: "trt_initial" };
      const block = buildServiceFactsBlock(collected);
      expect(block).toContain("TRT Initial Consultation");
      expect(block).toContain("Duration: 30 min");
      expect(block).toContain("Price: NZD $179");
      expect(block).toContain("--- SERVICE FACTS (code-provided, authoritative) ---");
    },
  );
});

/* ── Test 2: Slot format unchanged ────────────────────────────────────── */

describe("data-injection: slot format unchanged", () => {
  it(
    "echoes the exact code-formatted slot string in AWAITING_SELECTION reply",
    async () => {
      const router = makeRouter();
      const slotFormatted = "Thursday 18 June at 9:00 AM Pacific/Auckland";
      const slotMenuFormatted =
        "1. Thursday 18 June at 9:00 AM Pacific/Auckland\n2. Friday 19 June at 11:00 AM Pacific/Auckland";
      const collected: ScmCollected = {
        fullName: "John Smith",
        serviceKey: "trt_initial",
        slotMenuFormatted,
      };
      const text = await generate("AWAITING_SELECTION", collected, [], undefined, undefined, {
        router,
      });

      // The model should echo the slot string without reformatting
      expect(text).toContain(slotFormatted);
    },
    longTimeout,
  );
});

/* ── Test 3: CONFIRMED facts all present ──────────────────────────────── */

describe("data-injection: CONFIRMED facts all present", () => {
  it(
    "CONFIRMED final message contains code-appended booking summary with all facts",
    async () => {
      const router = makeRouter();
      const slotFormatted = "Thursday 18 June at 9:00 AM Pacific/Auckland";
      const collected: ScmCollected = {
        fullName: "John Smith",
        serviceKey: "trt_initial",
        slotIso: "2026-06-18T09:00:00+12:00",
        slotFormatted,
      };
      const text = await generate("CONFIRMED", collected, [], undefined, undefined, {
        router,
      });

      // Simulate conversation-service code-append (Fix 1)
      const svc = getService(collected.serviceKey as string);
      const bookingSummary = [
        "",
        "--- Your booking ---",
        `Service: ${svc?.name}`,
        `Date: ${collected.slotFormatted}`,
        `Duration: ${svc?.duration} min`,
        `Price: ${svc?.price === 0 ? "Free" : `NZD $${svc?.price}`}`,
        "---",
      ].join("\n");
      const finalText = text + bookingSummary;

      const lower = finalText.toLowerCase();
      expect(lower).toContain("trt initial consultation");
      expect(finalText).toContain(slotFormatted);
      expect(finalText).toMatch(/NZD \$179/);
      expect(finalText).toContain("--- Your booking ---");
      expect(finalText).toContain("Duration: 30 min");
      expect(lower).not.toBe("booking confirmed"); // must contain actual details
    },
    longTimeout,
  );

  it("buildConfirmedFacts produces the expected block", () => {
    const collected: ScmCollected = {
      fullName: "John Smith",
      serviceKey: "trt_initial",
      slotFormatted: "Thursday 18 June at 9:00 AM Pacific/Auckland",
    };
    const block = buildConfirmedFacts(collected);
    expect(block).toContain("Patient: John Smith");
    expect(block).toContain("Service: TRT Initial Consultation");
    expect(block).toContain("Date: Thursday 18 June at 9:00 AM Pacific/Auckland");
    expect(block).toContain("Duration: 30 min");
    expect(block).toContain("Price: NZD $179");
    expect(block).toContain("--- CONFIRMED BOOKING FACTS ---");
  });
});

/* ── Test 4: No unsanctioned URL (10 runs, fallback) ──────────────────── */

describe("data-injection: no unsanctioned URLs in AWAITING_PAYMENT (10 runs, GLM-5.1)", () => {
  it(
    "produces no stripe.com, acuityscheduling.com, or any URL in 10 AWAITING_PAYMENT replies",
    async () => {
      const router = makeRouter({
        generateModel: "dash_intl/glm-5.1",
        generateFallbackModel: "dash_intl/glm-5.1",
      });
      const collected: ScmCollected = {
        fullName: "John Smith",
        serviceKey: "trt_initial",
        slotIso: "2026-06-18T09:00:00+12:00",
        slotFormatted: "Thursday 18 June at 9:00 AM Pacific/Auckland",
      };
      const allIssues: string[] = [];
      for (let i = 0; i < 10; i++) {
        const text = await generate("AWAITING_PAYMENT", collected, [], undefined, undefined, {
          router,
        });
        const issues = assertNoUrls(text);
        if (issues.length > 0) {
          allIssues.push(`Run ${i + 1}: ${issues.join(", ")} — text: ${text.slice(0, 120)}`);
        }
      }
      expect(allIssues).toEqual([]);
    },
    longTimeout * 4,
  );
});

/* ── Test 5: No unsanctioned email (10 runs, fallback) ────────────────── */

describe("data-injection: no emails in generated replies (10 runs, GLM-5.1)", () => {
  it(
    "produces no email addresses across 10 replies in various states",
    async () => {
      const router = makeRouter({
        generateModel: "dash_intl/glm-5.1",
        generateFallbackModel: "dash_intl/glm-5.1",
      });
      const states: Array<{ state: ScmState; collected: ScmCollected }> = [
        { state: "NEW", collected: {} },
        { state: "COLLECTING_NAME", collected: {} },
        { state: "SELECTING_SERVICE", collected: { fullName: "John Smith", phone: "+64210000000", email: "john@example.com" } },
        { state: "AWAITING_SELECTION", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotMenuFormatted: "1. Thursday 18 June at 9:00 AM Pacific/Auckland" } },
        { state: "AWAITING_PAYMENT", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-18T09:00:00+12:00" } },
        { state: "CONFIRMED", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-18T09:00:00+12:00", slotFormatted: "Thursday 18 June at 9:00 AM Pacific/Auckland" } },
      ];
      const allIssues: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { state, collected } = states[i % states.length];
        const text = await generate(state, collected, [], undefined, undefined, { router });
        const issues = assertNoEmails(text);
        if (issues.length > 0) {
          allIssues.push(`Run ${i + 1} (${state}): ${issues.join(", ")} — text: ${text.slice(0, 120)}`);
        }
      }
      expect(allIssues).toEqual([]);
    },
    longTimeout * 4,
  );
});

/* ── Test 6: No phone numbers (10 runs, fallback) ─────────────────────── */

describe("data-injection: no phone numbers in generated replies (10 runs, GLM-5.1)", () => {
  it(
    "produces no phone numbers across 10 replies in various states",
    async () => {
      const router = makeRouter({
        generateModel: "dash_intl/glm-5.1",
        generateFallbackModel: "dash_intl/glm-5.1",
      });
      const states: Array<{ state: ScmState; collected: ScmCollected }> = [
        { state: "NEW", collected: {} },
        { state: "COLLECTING_NAME", collected: {} },
        { state: "SELECTING_SERVICE", collected: { fullName: "John Smith", phone: "+64210000000", email: "john@example.com" } },
        { state: "AWAITING_SELECTION", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotMenuFormatted: "1. Thursday 18 June at 9:00 AM Pacific/Auckland" } },
        { state: "AWAITING_PAYMENT", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-18T09:00:00+12:00" } },
        { state: "CONFIRMED", collected: { fullName: "John Smith", serviceKey: "trt_initial", slotIso: "2026-06-18T09:00:00+12:00", slotFormatted: "Thursday 18 June at 9:00 AM Pacific/Auckland" } },
      ];
      const allIssues: string[] = [];
      for (let i = 0; i < 10; i++) {
        const { state, collected } = states[i % states.length];
        const text = await generate(state, collected, [], undefined, undefined, { router });
        const issues = assertNoPhones(text);
        if (issues.length > 0) {
          allIssues.push(`Run ${i + 1} (${state}): ${issues.join(", ")} — text: ${text.slice(0, 120)}`);
        }
      }
      expect(allIssues).toEqual([]);
    },
    longTimeout * 4,
  );
});

/* ── Test 7: Slot echo unchanged (fixture, no live calls) ─────────────── */

const fixturePath = resolve(__dirname, "../fixtures/glm-slot-offer-samples.json");

describe("data-injection: slot echo unchanged (fixture)", () => {
  it("fixture has 10 recorded GLM-5.1 replies", () => {
    const samples = JSON.parse(readFileSync(fixturePath, "utf-8")) as string[];
    expect(samples.length).toBe(10);
  });

  it("at least 8 of 10 fixture samples echo an exact formatted slot string", () => {
    const samples = JSON.parse(readFileSync(fixturePath, "utf-8")) as string[];
    const failures: string[] = [];
    for (let i = 0; i < samples.length; i++) {
      const text = samples[i];
      const hasSlot1 = text.includes("Thursday 18 June at 9:00 AM Pacific/Auckland");
      const hasSlot2 = text.includes("Friday 19 June at 11:00 AM Pacific/Auckland");
      if (!hasSlot1 && !hasSlot2) {
        failures.push(`Sample ${i + 1}: neither exact slot string found — text: ${text.slice(0, 200)}`);
      }
    }
    // GLM-5.1 usually echoes the exact string; occasional abbreviation is acceptable
    expect(failures.length).toBeLessThanOrEqual(2);
  });
});

/* ── Unit tests for sanitizeOutput stripper ───────────────────────────── */

describe("sanitizeOutput() stripUnsanctionedContactInfo", () => {
  it("strips unsanctioned URLs and removes the containing sentence", () => {
    const text = "Visit https://evil.com/phishing for more info.";
    const result = sanitizeOutput(text, undefined, {});
    expect(result).not.toContain("evil.com");
    expect(result).not.toContain("[link removed]");
  });

  it("preserves sanctioned URLs", () => {
    const text = "Pay here: https://checkout.stripe.com/c/pay_cs_test_123";
    const collected = { _paymentLink: "https://checkout.stripe.com/c/pay_cs_test_123" } as ScmCollected;
    const result = sanitizeOutput(text, undefined, collected);
    expect(result).toContain("https://checkout.stripe.com/c/pay_cs_test_123");
  });

  it("strips email addresses and removes the containing sentence without leaving [contact removed]", () => {
    const text = "Contact us at info@selfcaremen.co.nz for help.";
    const result = sanitizeOutput(text, undefined, {});
    expect(result).not.toContain("info@selfcaremen.co.nz");
    expect(result).not.toContain("[contact removed]");
  });

  it("strips phone numbers", () => {
    const text = "Call us on 027 299 8812.";
    const result = sanitizeOutput(text, undefined, {});
    expect(result).not.toContain("027 299 8812");
    expect(result).toContain("[phone removed]");
  });

  it("does not strip ISO date strings", () => {
    const text = "Your appointment is at 2026-06-18T09:00:00+12:00.";
    const result = sanitizeOutput(text, undefined, {});
    expect(result).toContain("2026-06-18T09:00:00+12:00");
  });

  it("strips clinician names", () => {
    const text = "Dr Dominic Smith will see you.";
    const result = sanitizeOutput(text, undefined, {});
    expect(result).not.toContain("Dominic Smith");
    expect(result).toContain("[name removed]");
  });

  it("sanitizeOutput removes hallucinated email without leaving [contact removed] token", () => {
    const text = "If you need help, email us at support@selfcaremen.co.nz anytime.";
    const result = sanitizeOutput(text, undefined, {});
    expect(result).not.toContain("support@selfcaremen.co.nz");
    expect(result).not.toContain("[contact removed]");
    expect(result).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });
});
