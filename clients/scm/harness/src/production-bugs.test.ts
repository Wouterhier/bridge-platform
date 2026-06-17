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
import { ConversationService, recoverUnsentReplies, type InboundPayload } from "../../service/src/conversation-service.js";
import { PaymentService, WebhookError } from "../../payment-service/src/payment-service.js";
import { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import type { ModelRouter } from "@romea/model-router";
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { onPaymentConfirmed } from "../../payment-service/src/payment-processor.js";

config({ path: resolve(process.cwd(), "clients/scm/.env") });

const DATABASE_URL = process.env.DATABASE_URL ?? "";

/* ── Helpers ───────────────────────────────────────────────────── */

function makeStripeSignature(payload: string, secret: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${payload}`;
  const signature = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${t},v1=${signature}`;
}

function createMockGhlClient(): ReturnType<typeof createGhlClient> {
  return {
    getContact: vi.fn(async () => ({ id: "c1" })),
    searchContacts: vi.fn(async () => []),
    createContact: vi.fn(async () => ({ id: "c1" })),
    updateContact: vi.fn(async () => ({ id: "c1" })),
    addContactTags: vi.fn(async () => ({ id: "c1" })),
    removeContactTags: vi.fn(async () => ({ id: "c1" })),
    sendMessage: vi.fn(async () => ({})),
    getPipelineOpportunities: vi.fn(async () => []),
    createOpportunity: vi.fn(async () => ({ id: "opp-1" })),
    updateOpportunityStage: vi.fn(async () => ({ id: "opp-1" })),
    updateOpportunityStageSafe: vi.fn(async () => ({ id: "opp-1" })),
  } as unknown as ReturnType<typeof createGhlClient>;
}

function createMockAcuityClient(
  overrides: { appointment?: { id: number }; delayMs?: number } = {},
): ReturnType<typeof createAcuityClient> {
  const { appointment = { id: 999 }, delayMs = 0 } = overrides;
  return {
    getAppointmentTypes: vi.fn(async () => []),
    getAvailability: vi.fn(async () => []),
    createAppointment: vi.fn(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return appointment;
    }),
    getAppointment: vi.fn(async () => appointment),
    updateAppointmentFormFields: vi.fn(async () => appointment),
  } as unknown as ReturnType<typeof createAcuityClient>;
}

function createMockStripeClient(
  overrides: { session?: Stripe.Checkout.Session } = {},
): ReturnType<typeof createStripeClient> {
  const { session } = overrides;
  return {
    stripe: {} as any,
    createCheckoutSession: vi.fn(async () => ({
      id: "cs_test_123",
      url: "https://pay.stripe.com/test",
      status: "open",
    })),
    getCheckoutSession: vi.fn(
      async () =>
        session ?? {
          id: "cs_test_123",
          url: "https://pay.stripe.com/test",
          status: "open",
          payment_status: "paid",
        },
    ),
    listLineItems: vi.fn(async () => ({ data: [] })),
    constructWebhookEvent: vi.fn((payload, signature, secret) => {
      const sigParts = (signature as string).split(",");
      const tPart = sigParts.find((p: string) => p.startsWith("t="));
      const v1Part = sigParts.find((p: string) => p.startsWith("v1="));
      if (!tPart || !v1Part) throw new Error("Invalid signature format");
      const t = tPart.replace("t=", "");
      const expectedSig = makeStripeSignature(payload as string, secret, Number(t));
      if (signature !== expectedSig) throw new Error("Invalid signature");
      return JSON.parse(payload as string);
    }),
  } as unknown as ReturnType<typeof createStripeClient>;
}

function createMockRouter(): ModelRouter {
  return {
    complete: vi.fn(async () => ({
      text: "Mock reply",
      provider: "mock",
      model: "mock",
    })),
    escalate: vi.fn(async () => ({
      text: "Escalated mock reply",
      provider: "mock",
      model: "mock",
    })),
  } as unknown as ModelRouter;
}

function makePayload(overrides: Partial<InboundPayload> = {}): InboundPayload {
  return {
    contact_id: "test-contact-001",
    location_id: "test-loc-001",
    message: { id: "msg-001", body: "Hello", direction: "inbound", type: "SMS" },
    ...overrides,
  };
}

/**
 * Consolidated regression test: every production bug class.
 *
 * 1. Acuity double-book race (idempotency key)
 * 2. Stripe unsigned webhook rejected with 400
 * 3. GHL downgrade guard: BOOKED does not regress to AI_REPLIED
 * 4. GHL escalation on BOOKED still fires to HUMAN_TOUCH
 * 5. At-least-once recovery: conversation crash between commit and send
 * 6. At-least-once recovery: payment crash between booking and confirmation
 * 7. id-without-body does not crash
 */
describe("production bugs — consolidated regression", () => {
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

  /* ── 1. Acuity double-book race ──────────────────────────────── */
  it("calls acuity createAppointment exactly once when two processes race", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient({ appointment: { id: 99999 }, delayMs: 100 });
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const contactId = "test-contact-idempotent";
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";

    /* Seed conversation */
    await db.query(
      `INSERT INTO conversations (id, location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, $3, 'AWAITING_PAYMENT', $4, '{}')`,
      [
        conversationId,
        "loc-001",
        contactId,
        JSON.stringify({
          fullName: "Race Condition",
          phone: "+64210000003",
          email: "race@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T12:00:00+12:00",
        }),
      ],
    );

    /* Seed payment session */
    await db.query(
      `INSERT INTO payment_sessions
       (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "cs_test_idempotent",
        "pending",
        "2026-06-20T12:00:00+12:00",
        "53224493",
        contactId,
        conversationId,
        "checkout-test-idempotent",
        JSON.stringify({
          fullName: "Race Condition",
          phone: "+64210000003",
          email: "race@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T12:00:00+12:00",
        }),
      ],
    );

    const stripeSession = {
      id: "cs_test_idempotent",
      payment_status: "paid",
      customer_email: "race@selfcaremen.co.nz",
      metadata: {
        conversation_id: conversationId,
        service_key: "trt_initial",
        slot_iso: "2026-06-20T12:00:00+12:00",
        contact_id: contactId,
        appointment_type_id: "53224493",
        idempotency_key: "checkout-test-idempotent",
      },
    } as unknown as Stripe.Checkout.Session;

    const deps = {
      db,
      ghl,
      acuity,
      stripe,
      router,
      ghlPipelineId: "pipe-001",
      ghlLocationId: "loc-001",
    };

    /* Fire two onPaymentConfirmed calls simultaneously */
    await Promise.all([onPaymentConfirmed(stripeSession, deps), onPaymentConfirmed(stripeSession, deps)]);

    /* Assert createAppointment called exactly once */
    expect(acuity.createAppointment).toHaveBeenCalledTimes(1);

    /* Assert exactly one confirmation message sent */
    expect(ghl.sendMessage).toHaveBeenCalledTimes(1);
  });

  /* ── 2. Stripe unsigned webhook rejected with 400 ────────────── */
  it("rejects unsigned Stripe webhook with 400", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new PaymentService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      ghlPipelineId: "pipe-001",
      ghlLocationId: "loc-001",
      stripeWebhookSecret: "whsec_test",
      pollIntervalMs: 30000,
    });

    const event = {
      id: "evt_bad_sig",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_bad", customer_email: "bad@example.com" } },
    };
    const payload = JSON.stringify(event);
    const badSignature = makeStripeSignature(payload, "wrong_secret");

    await expect(service.handleWebhook(Buffer.from(payload), badSignature)).rejects.toBeInstanceOf(
      WebhookError,
    );

    /* Assert no side effects */
    expect(acuity.createAppointment).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });

  /* ── 3. GHL downgrade guard: BOOKED → AI_REPLIED prevented ───── */
  it("GHL downgrade guard prevents BOOKED from regressing to AI_REPLIED", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));

    const client = createGhlClient({ token: "test-pit" });
    const fetchStub = vi.fn(async () =>
      new Response(JSON.stringify({ id: "o1", pipelineStageId: "6459bbb1-4517-4383-b4cb-dffe867f4c54" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchStub);

    const ELIGIBILITY_BOOKED = "b000d5c7-de71-4997-b263-74162c416736";
    const AI_REPLIED = "6459bbb1-4517-4383-b4cb-dffe867f4c54";

    const result = await client.updateOpportunityStageSafe("loc1", "o1", AI_REPLIED, ELIGIBILITY_BOOKED);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("stage_downgrade_prevented");
    expect(result.pipelineStageId).toBe(ELIGIBILITY_BOOKED);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /* ── 4. GHL escalation on BOOKED still fires to HUMAN_TOUCH ─── */
  it("GHL escalation from BOOKED to HUMAN_TOUCH is allowed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));

    const client = createGhlClient({ token: "test-pit" });
    let updateCalled = false;
    let updateStageId: string | undefined;
    const fetchStub = vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") {
        updateCalled = true;
        const body = JSON.parse(init.body as string);
        updateStageId = body.pipelineStageId;
      }
      return new Response(
        JSON.stringify({ id: "o1", pipelineStageId: "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4" }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchStub);

    const ELIGIBILITY_BOOKED = "b000d5c7-de71-4997-b263-74162c416736";
    const HUMAN_TOUCH = "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4";

    const result = await client.updateOpportunityStageSafe("loc1", "o1", HUMAN_TOUCH, ELIGIBILITY_BOOKED);

    expect(updateCalled).toBe(true);
    expect(updateStageId).toBe(HUMAN_TOUCH);
    expect(result.pipelineStageId).toBe(HUMAN_TOUCH);
    expect(result.escalatedAt).toBe("2026-06-16T12:00:00.000Z");

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /* ── 5. At-least-once: conversation crash between commit and send ─ */
  it("recovers unsent reply after conversation service crash", async () => {
    const ghl = createMockGhlClient();
    let callCount = 0;
    (ghl.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("GHL transient error");
      return {};
    });

    const service = new ConversationService({
      db,
      ghl,
      acuity: createMockAcuityClient(),
      stripe: createMockStripeClient(),
      router: createMockRouter(),
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-crash";

    /* Seed conversation at COLLECTING_NAME */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'COLLECTING_NAME', '{}', '{}')`,
      ["test-loc-001", contactId],
    );

    const result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "crash-1", body: "John Smith", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* Assert processed_messages row exists with sent_at IS NULL */
    const pmResult = await db.query(
      `SELECT sent_at, send_attempts, send_payload FROM processed_messages WHERE message_id = $1`,
      ["crash-1"],
    );
    expect(pmResult.rows.length).toBe(1);
    expect(pmResult.rows[0].sent_at).toBeNull();
    expect(pmResult.rows[0].send_attempts).toBe(1);

    /* Simulate restart: call recoverUnsentReplies */
    await recoverUnsentReplies(db, (locationId: string, contactId: string, payload: unknown) =>
      ghl.sendMessage(locationId, contactId, payload as { message: string; channel: "sms" | "live_chat" | "whatsapp" | "email" }),
    );

    /* Assert ghl.sendMessage was called again */
    expect(callCount).toBe(2);

    /* Assert sent_at is now set */
    const pmResultAfter = await db.query(
      `SELECT sent_at FROM processed_messages WHERE message_id = $1`,
      ["crash-1"],
    );
    expect(pmResultAfter.rows[0].sent_at).not.toBeNull();
  });

  /* ── 6. At-least-once: payment crash between booking and confirm ─ */
  it("recovers and sends confirmation after payment service crash", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient({ appointment: { id: 123 } });
    const stripe = createMockStripeClient();
    const router = {
      complete: vi.fn(async () => ({
        text: "Your appointment is confirmed. See you then!",
        provider: "mock",
        model: "mock",
      })),
      escalate: vi.fn(async () => ({
        text: "Escalated mock reply",
        provider: "mock",
        model: "mock",
      })),
    } as unknown as ModelRouter;

    let sendAttempts = 0;
    (ghl.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sendAttempts++;
      if (sendAttempts === 1) throw new Error("Simulated GHL crash");
    });

    const contactId = "test-contact-crash-confirm";
    const conversationId = "550e8400-e29b-41d4-a716-446655440006";

    /* Seed conversation */
    await db.query(
      `INSERT INTO conversations (id, location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, $3, 'AWAITING_PAYMENT', $4, '{}')`,
      [
        conversationId,
        "loc-001",
        contactId,
        JSON.stringify({
          fullName: "Crash Test",
          phone: "+64210000005",
          email: "crash@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T14:00:00+12:00",
        }),
      ],
    );

    /* Seed payment session */
    await db.query(
      `INSERT INTO payment_sessions
       (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "cs_test_crash_confirm",
        "pending",
        "2026-06-20T14:00:00+12:00",
        "53224493",
        contactId,
        conversationId,
        "checkout-test-crash-confirm",
        JSON.stringify({
          fullName: "Crash Test",
          phone: "+64210000005",
          email: "crash@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T14:00:00+12:00",
        }),
      ],
    );

    const service = new PaymentService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      ghlPipelineId: "pipe-001",
      ghlLocationId: "loc-001",
      stripeWebhookSecret: "whsec_test",
      pollIntervalMs: 30000,
    });

    const event = {
      id: "evt_crash_confirm",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_crash_confirm",
          customer_email: "crash@selfcaremen.co.nz",
          metadata: {
            conversation_id: conversationId,
            service_key: "trt_initial",
            slot_iso: "2026-06-20T14:00:00+12:00",
            contact_id: contactId,
            appointment_type_id: "53224493",
            idempotency_key: "checkout-test-crash-confirm",
          },
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = makeStripeSignature(payload, "whsec_test");

    /* Webhook succeeds (booking done) but GHL send throws */
    await service.handleWebhook(Buffer.from(payload), signature);

    /* Assert payment_sessions.status = 'paid' */
    const psResult = await db.query(
      `SELECT id, status, acuity_appointment_id FROM payment_sessions WHERE stripe_session_id = $1`,
      ["cs_test_crash_confirm"],
    );
    expect(psResult.rows[0].status).toBe("paid");
    expect(psResult.rows[0].acuity_appointment_id).toBe("123");

    /* Assert processed_messages row exists with sent_at IS NULL */
    const pmResult = await db.query(
      `SELECT sent_at, send_payload FROM processed_messages WHERE message_id = $1`,
      [`scm-confirm-${psResult.rows[0].id}`],
    );
    expect(pmResult.rows.length).toBe(1);
    expect(pmResult.rows[0].sent_at).toBeNull();
    expect(pmResult.rows[0].send_payload.message).toContain("confirmed");

    /* Simulate payment-service restart: recover unsent replies */
    await recoverUnsentReplies(db, (locationId: string, contactId: string, payload: unknown) =>
      ghl.sendMessage(locationId, contactId, payload as { message: string; channel: "sms" | "live_chat" | "whatsapp" | "email" }),
    );

    /* Assert ghlClient.sendMessage called again with confirmation */
    expect(ghl.sendMessage).toHaveBeenCalledTimes(2);
    const secondCall = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[1]).toBe(contactId);
    expect(secondCall[2].message).toContain("confirmed");

    /* Assert sent_at is now set */
    const pmResultAfter = await db.query(
      `SELECT sent_at FROM processed_messages WHERE message_id = $1`,
      [`scm-confirm-${psResult.rows[0].id}`],
    );
    expect(pmResultAfter.rows[0].sent_at).not.toBeNull();
  });

  /* ── 7. id-without-body does not crash ───────────────────────── */
  it("does not crash on message with id but no body", async () => {
    const ghl = createMockGhlClient();
    const service = new ConversationService({
      db,
      ghl,
      acuity: createMockAcuityClient(),
      stripe: createMockStripeClient(),
      router: createMockRouter(),
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    /* Message id exists but body is empty string → system event */
    const r1 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-idonly-1",
        message: { id: "idonly-1", body: "", direction: "inbound", type: "SMS" },
      }),
    );
    expect(r1.sent).toBe(false);
    expect(() => r1).not.toThrow();

    /* Message id exists but body is undefined → malformed */
    const r2 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-idonly-2",
        message: { id: "idonly-2", body: undefined as unknown as string, direction: "inbound", type: "email" },
      }),
    );
    expect(r2.sent).toBe(false);
    expect(() => r2).not.toThrow();
  });
});
