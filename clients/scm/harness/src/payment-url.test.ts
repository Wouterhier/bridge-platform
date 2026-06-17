import {
  describe,
  expect,
  it,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { Pool } from "pg";
import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { ConversationService, type InboundPayload } from "../../service/src/conversation-service.js";
import { sanitizeOutput } from "../../flow/src/generate.js";
import type { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import type { ModelRouter } from "@romea/model-router";

config({ path: resolve(process.cwd(), "clients/scm/.env") });

const DATABASE_URL = process.env.DATABASE_URL ?? "";

function createMockGhlClient(): ReturnType<typeof createGhlClient> {
  return {
    getContact: vi.fn(async () => ({ id: "c1" })),
    searchContacts: vi.fn(async () => []),
    createContact: vi.fn(async () => ({ id: "c1" })),
    updateContact: vi.fn(async () => ({ id: "c1" })),
    sendMessage: vi.fn(async () => ({})),
    getPipelineOpportunities: vi.fn(async () => []),
    createOpportunity: vi.fn(async () => ({ id: "opp-1" })),
    updateOpportunityStage: vi.fn(async () => ({ id: "opp-1" })),
    updateOpportunityStageSafe: vi.fn(async () => ({ id: "opp-1" })),
  } as unknown as ReturnType<typeof createGhlClient>;
}

function createMockAcuityClient(): ReturnType<typeof createAcuityClient> {
  return {
    getAppointmentTypes: vi.fn(async () => []),
    getAvailability: vi.fn(async () => []),
    createAppointment: vi.fn(async () => ({ id: 999 })),
    getAppointment: vi.fn(async () => ({ id: 999 })),
    updateAppointmentFormFields: vi.fn(async () => ({ id: 999 })),
  } as unknown as ReturnType<typeof createAcuityClient>;
}

function createMockStripeClient(): ReturnType<typeof createStripeClient> {
  return {
    stripe: {} as any,
    createCheckoutSession: vi.fn(async () => ({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_live_test_123",
      status: "open",
    })),
    getCheckoutSession: vi.fn(async () => ({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_live_test_123",
      status: "open",
    })),
    listLineItems: vi.fn(async () => ({ data: [] })),
    constructWebhookEvent: vi.fn(() => ({})),
  } as unknown as ReturnType<typeof createStripeClient>;
}

function makePayload(overrides: Partial<InboundPayload> = {}): InboundPayload {
  return {
    contact_id: "test-contact-001",
    location_id: "test-loc-001",
    message: {
      id: "msg-001",
      body: "Hello",
      direction: "inbound",
      type: "SMS",
    },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Fixture                                                           */
/* ------------------------------------------------------------------ */

const fixturePath = resolve(process.cwd(), "clients/scm/harness/fixtures/glm-payment-nudge-samples.json");
const paymentNudgeSamples: string[] = JSON.parse(readFileSync(fixturePath, "utf-8"));

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe("payment-url regression", () => {
  let db: Pool;

  beforeAll(() => {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL is required for integration tests");
    }
    db = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await db?.end();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM processed_messages WHERE contact_id LIKE 'test-%'`);
    await db.query(`DELETE FROM payment_sessions WHERE contact_id LIKE 'test-%'`);
    await db.query(`DELETE FROM conversations WHERE contact_id LIKE 'test-%'`);
  });

  /* ---------------------------------------------------------------- */
  /*  Test A — Real checkout URL is injected deterministically         */
  /* ---------------------------------------------------------------- */
  it("injects the real Stripe checkout URL and contains no fake URLs", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();

    /* Router that simulates a model that accidentally includes a fake URL */
    const hallucinatingRouter = {
      complete: vi.fn(async () => ({
        text: 'Your slot is held. You can complete payment here: https://pay.stripe.com/selfcaremen/fake123. Let me know once done.',
        provider: "mock",
        model: "mock",
      })),
      escalate: vi.fn(async () => ({
        text: 'Escalated',
        provider: "mock",
        model: "mock",
      })),
    } as unknown as ModelRouter;

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router: hallucinatingRouter,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-payment-url";
    const realUrl = "https://checkout.stripe.com/c/pay/cs_live_test_123";

    /* Seed conversation at AWAITING_PAYMENT with all fields and a real payment link */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'AWAITING_PAYMENT', $3, '{}')`,
      [
        "test-loc-001",
        contactId,
        JSON.stringify({
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john.smith@example.com",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T09:00:00+12:00",
          _paymentLink: realUrl,
          _stripeSessionId: "cs_test_123",
        }),
      ],
    );

    const result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "pay-url-1", body: "I will pay soon", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* Find the outbound message sent to GHL */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const outboundCall = sendCalls.find(
      (call: unknown[]) =>
        (call[2] as { message?: string })?.message?.includes("checkout.stripe.com"),
    );
    expect(outboundCall).toBeTruthy();

    const outboundMessage = (outboundCall![2] as { message: string }).message;

    /* Assert the real URL is present */
    expect(outboundMessage).toContain(realUrl);

    /* Assert the fake URL is NOT present */
    expect(outboundMessage).not.toContain("pay.stripe.com/selfcaremen");
    expect(outboundMessage).not.toContain("pay.stripe.com");

    /* Assert no other stripe.com URL besides the real one */
    const stripeUrls = outboundMessage.match(/https?:\/\/[^\s]*stripe\.com\/[^\s]*/gi);
    expect(stripeUrls).toEqual([realUrl]);
  });

  /* ---------------------------------------------------------------- */
  /*  Test B — Fake URL from generate() is stripped before send        */
  /* ---------------------------------------------------------------- */
  it("strips model-hallucinated Stripe URLs before appending the real one", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();

    const fakeUrl = "https://pay.stripe.com/selfcaremen/fake456";
    const realUrl = "https://checkout.stripe.com/c/pay/cs_live_real_456";

    const maliciousRouter = {
      complete: vi.fn(async () => ({
        text: `Here is your payment link: ${fakeUrl} — please pay within 30 minutes.`,
        provider: "mock",
        model: "mock",
      })),
      escalate: vi.fn(async () => ({
        text: "Escalated",
        provider: "mock",
        model: "mock",
      })),
    } as unknown as ModelRouter;

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router: maliciousRouter,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-strip-url";

    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'AWAITING_PAYMENT', $3, '{}')`,
      [
        "test-loc-001",
        contactId,
        JSON.stringify({
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john@example.com",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T09:00:00+12:00",
          _paymentLink: realUrl,
        }),
      ],
    );

    const result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "strip-url-1", body: "ok", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const outboundCall = sendCalls.find(
      (call: unknown[]) => (call[1] as string) === contactId,
    );
    expect(outboundCall).toBeTruthy();

    const outboundMessage = (outboundCall![2] as { message: string }).message;

    /* Fake URL must be gone */
    expect(outboundMessage).not.toContain(fakeUrl);
    expect(outboundMessage).not.toContain("pay.stripe.com");

    /* Real URL must be present */
    expect(outboundMessage).toContain(realUrl);
  });

  /* ---------------------------------------------------------------- */
  /*  Test C — Fixture-based stripper verification                     */
  /* ---------------------------------------------------------------- */
  it("sanitizeOutput strips hallucinated stripe.com URLs from real GLM-5.1 samples", () => {
    const collected = {
      fullName: "John Smith",
      serviceKey: "trt_initial",
      slotIso: "2026-06-20T09:00:00+12:00",
      _paymentLink: "https://checkout.stripe.com/c/pay/cs_live_test_123",
    };

    const failures: Array<{ index: number; text: string; stripped: string }> = [];

    for (let i = 0; i < paymentNudgeSamples.length; i++) {
      const raw = paymentNudgeSamples[i];
      const stripped = sanitizeOutput(raw, "AWAITING_PAYMENT", collected);

      if (/https?:\/\/[^\s]*stripe\.com/i.test(stripped)) {
        failures.push({ index: i, text: raw, stripped });
      }
    }

    if (failures.length > 0) {
      console.error("Stripe URL stripper failures:", failures);
    }

    expect(failures).toEqual([]);
  });
});
