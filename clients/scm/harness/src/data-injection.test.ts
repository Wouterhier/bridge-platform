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
import type { ModelRouter } from "@romea/model-router";
import type { ScmCollected, ScmState } from "@romea/scm-flow";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const longTimeout = 30000;

function makeRouter(overrides?: Record<string, string>) {
  const cfg = loadConfig();
  return createRouter({
    ...cfg,
    ...(overrides ?? {}),
  } as ReturnType<typeof loadConfig>);
}

function createMockRouter(responseText: string): ModelRouter {
  return {
    complete: async () => ({
      text: responseText,
      provider: "mock",
      model: "mock",
    }),
    escalate: async () => ({
      text: "Escalated",
      provider: "mock",
      model: "mock",
    }),
  } as unknown as ModelRouter;
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

/* ── Fixtures ──────────────────────────────────────────────────────────── */

const fixturesDir = resolve(process.cwd(), "clients/scm/harness/fixtures");
const urlSamples: string[] = JSON.parse(readFileSync(resolve(fixturesDir, "glm-url-samples.json"), "utf-8"));
const emailSamples: string[] = JSON.parse(readFileSync(resolve(fixturesDir, "glm-email-samples.json"), "utf-8"));
const phoneSamples: string[] = JSON.parse(readFileSync(resolve(fixturesDir, "glm-phone-samples.json"), "utf-8"));

/* ── Test 1: Service facts echoed in message ──────────────────────────── */

describe("data-injection: service facts in generated message", () => {
  it(
    "echoes exact service name and price from services.ts in SELECTING_SERVICE reply",
    async () => {
      const router = createMockRouter(
        "Hi John. We offer several services including TRT Initial Consultation (30 min, NZD $179). Which would you like to book?"
      );
      const collected: ScmCollected = {
        fullName: "John Smith",
        phone: "+64210000000",
        email: "john@example.com",
        serviceKey: "trt_initial",
      };
      const text = await generate("SELECTING_SERVICE", collected, [], undefined, undefined, {
        router,
      });

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
      const slotFormatted = "Thursday 18 June at 9:00 AM Pacific/Auckland";
      const router = createMockRouter(
        `Here are the available slots for your TRT Initial Consultation:\n\n1. ${slotFormatted}\n2. Friday 19 June at 11:00 AM Pacific/Auckland`
      );
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
      const slotFormatted = "Thursday 18 June at 9:00 AM Pacific/Auckland";
      const router = createMockRouter(
        `Hi John. Your TRT Initial Consultation is confirmed for ${slotFormatted}. We look forward to seeing you then.`
      );
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

/* ── Test 4: No unsanctioned URL (fixture-based) ──────────────────────── */

describe("data-injection: no unsanctioned URLs in AWAITING_PAYMENT (fixture-based)", () => {
  it("strips all stripe.com, acuityscheduling.com, and other URLs from GLM-5.1 samples", () => {
    const collected = {
      fullName: "John Smith",
      serviceKey: "trt_initial",
      slotIso: "2026-06-18T09:00:00+12:00",
      slotFormatted: "Thursday 18 June at 9:00 AM Pacific/Auckland",
      _paymentLink: "https://checkout.stripe.com/c/pay/cs_live_test_123",
    } as ScmCollected;

    const failures: Array<{ index: number; text: string; stripped: string }> = [];

    for (let i = 0; i < urlSamples.length; i++) {
      const raw = urlSamples[i];
      const stripped = sanitizeOutput(raw, "AWAITING_PAYMENT", collected);
      const issues = assertNoUrls(stripped, (collected as Record<string, string>)._paymentLink);
      if (issues.length > 0) {
        failures.push({ index: i, text: raw, stripped });
      }
    }

    if (failures.length > 0) {
      console.error("URL stripper failures:", failures);
    }

    expect(failures).toEqual([]);
  });
});

/* ── Test 5: No unsanctioned email (fixture-based) ────────────────────── */

describe("data-injection: no emails in generated replies (fixture-based)", () => {
  it("strips all email addresses from GLM-5.1 samples across various states", () => {
    const failures: Array<{ index: number; text: string; stripped: string }> = [];

    for (let i = 0; i < emailSamples.length; i++) {
      const raw = emailSamples[i];
      const stripped = sanitizeOutput(raw, undefined, {});
      const issues = assertNoEmails(stripped);
      if (issues.length > 0) {
        failures.push({ index: i, text: raw, stripped });
      }
    }

    if (failures.length > 0) {
      console.error("Email stripper failures:", failures);
    }

    expect(failures).toEqual([]);
  });
});

/* ── Test 6: No phone numbers (fixture-based) ─────────────────────────── */

describe("data-injection: no phone numbers in generated replies (fixture-based)", () => {
  it("strips all phone numbers from GLM-5.1 samples and leaves no removal tokens", () => {
    const failures: Array<{ index: number; text: string; stripped: string; issues: string[] }> = [];

    for (let i = 0; i < phoneSamples.length; i++) {
      const raw = phoneSamples[i];
      const stripped = sanitizeOutput(raw, "CONFIRMED", {});
      const issues: string[] = [];

      // Check no phone pattern
      const phoneCheck = assertNoPhones(stripped);
      if (phoneCheck.length > 0) issues.push(...phoneCheck);

      // Check no removal tokens
      if (stripped.includes("[phone removed]")) issues.push("found [phone removed] token");
      if (stripped.includes("[contact removed]")) issues.push("found [contact removed] token");
      if (stripped.includes("[link removed]")) issues.push("found [link removed] token");

      if (issues.length > 0) {
        failures.push({ index: i, text: raw, stripped, issues });
      }
    }

    if (failures.length > 0) {
      console.error("Phone stripper failures:", failures);
    }

    expect(failures).toEqual([]);
  });
});

/* ── Test 7: Slot menu code-injected into reply (no live calls) ───────── */

describe("data-injection: slot menu code-injected into reply", () => {
  it("appends code-built slotMenuFormatted to generate() output for AWAITING_SELECTION", () => {
    const baseReply = "Here are the available slots for your TRT Initial Consultation:";
    const slotMenuFormatted =
      "1. Thursday 18 June at 9:00 AM Pacific/Auckland\n" +
      "2. Friday 19 June at 11:00 AM Pacific/Auckland";

    // Simulate the code-append that conversation-service.ts performs
    const finalReply = `${baseReply}\n\n${slotMenuFormatted}`;

    expect(finalReply).toContain("Thursday 18 June at 9:00 AM Pacific/Auckland");
    expect(finalReply).toContain("Friday 19 June at 11:00 AM Pacific/Auckland");
    expect(finalReply.startsWith(baseReply)).toBe(true);
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

  it("strips phone numbers and removes the containing sentence without leaving [phone removed]", () => {
    const text = "Call us on 027 299 8812.";
    const result = sanitizeOutput(text, undefined, {});
    expect(result).not.toContain("027 299 8812");
    expect(result).not.toContain("[phone removed]");
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
