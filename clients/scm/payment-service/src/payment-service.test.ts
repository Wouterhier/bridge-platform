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
import { PaymentService, WebhookError } from "./payment-service.js";
import { onPaymentConfirmed } from "./payment-processor.js";
import type { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import type { ModelRouter } from "@romea/model-router";
import { recoverUnsentReplies } from "@romea/bridge-db";
import { createMockGhlClient } from "../../harness/src/mocks/ghl-mock.js";
import { createHmac } from "node:crypto";
import Stripe from "stripe";

config({ path: resolve(process.cwd(), "clients/scm/.env") });

const DATABASE_URL = process.env.DATABASE_URL ?? "";

function makeStripeSignature(
  payload: string,
  secret: string,
  timestamp?: number,
): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");
  return `t=${t},v1=${signature}`;
}



function createMockAcuityClient(
  overrides: { appointment?: { id: number }; delayMs?: number } = {},
): ReturnType<typeof createAcuityClient> {
  const { appointment = { id: 999 }, delayMs = 0 } = overrides;
  return {
    getAppointmentTypes: vi.fn(async () => []),
    getAvailability: vi.fn(async () => []),
    createAppointment: vi.fn(async () => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
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
      const sigParts = signature.split(",");
      const tPart = sigParts.find((p: string) => p.startsWith("t="));
      const v1Part = sigParts.find((p: string) => p.startsWith("v1="));
      if (!tPart || !v1Part) throw new Error("Invalid signature format");
      const t = tPart.replace("t=", "");
      const expectedSig = makeStripeSignature(
        payload as string,
        secret,
        Number(t),
      );
      if (signature !== expectedSig)
        throw new Error("Invalid signature");
      return JSON.parse(payload as string);
    }),
  } as unknown as ReturnType<typeof createStripeClient>;
}

function createMockRouter(): ModelRouter {
  return {
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
}

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe("payment-service", () => {
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
    await db.query(
      `DELETE FROM processed_messages WHERE contact_id LIKE 'test-%'`,
    );
    await db.query(
      `DELETE FROM payment_sessions WHERE contact_id LIKE 'test-%'`,
    );
    await db.query(
      `DELETE FROM conversations WHERE contact_id LIKE 'test-%'`,
    );
  });

  /* ---------------------------------------------------------------- */
  /*  Test 1 — Paid path end to end                                    */
  /* ---------------------------------------------------------------- */
  it("books a paid appointment end to end via webhook", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient({ appointment: { id: 77777 } });
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

    const contactId = "test-contact-paid-e2e";
    const conversationId = "550e8400-e29b-41d4-a716-446655440001";

    /* Seed conversation */
    await db.query(
      `INSERT INTO conversations (id, location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, $3, 'AWAITING_PAYMENT', $4, '{}')`,
      [
        conversationId,
        "loc-001",
        contactId,
        JSON.stringify({
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john.smith@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T09:00:00+12:00",
        }),
      ],
    );

    /* Seed payment session */
    await db.query(
      `INSERT INTO payment_sessions
       (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "cs_test_paid_e2e",
        "pending",
        "2026-06-20T09:00:00+12:00",
        "53224493",
        contactId,
        conversationId,
        "checkout-test-e2e",
        JSON.stringify({
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john.smith@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T09:00:00+12:00",
        }),
      ],
    );

    /* Seed opportunity */
    (
      ghl.getPipelineOpportunities as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      {
        id: "opp-paid-e2e",
        pipelineId: "pipe-001",
        pipelineStageId: "6459bbb1-4517-4383-b4cb-dffe867f4c54",
        contactId,
      },
    ]);

    /* Construct valid webhook event */
    const event = {
      id: "evt_paid_e2e",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_paid_e2e",
          customer_email: "john.smith@selfcaremen.co.nz",
          metadata: {
            conversation_id: conversationId,
            service_key: "trt_initial",
            slot_iso: "2026-06-20T09:00:00+12:00",
            contact_id: contactId,
            appointment_type_id: "53224493",
            idempotency_key: "checkout-test-e2e",
          },
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = makeStripeSignature(payload, "whsec_test");

    await service.handleWebhook(Buffer.from(payload), signature);

    /* Assert payment_sessions.status = 'paid' */
    const psResult = await db.query(
      `SELECT status, acuity_appointment_id FROM payment_sessions WHERE stripe_session_id = $1`,
      ["cs_test_paid_e2e"],
    );
    expect(psResult.rows[0].status).toBe("paid");
    expect(psResult.rows[0].acuity_appointment_id).toBe("77777");

    /* Assert Acuity createAppointment called exactly once with idempotency key */
    expect(acuity.createAppointment).toHaveBeenCalledTimes(1);
    const acuityCall = (
      acuity.createAppointment as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];
    expect(acuityCall.idempotencyKey).toBe("checkout-test-e2e");

    /* Assert GHL confirmation message sent */
    expect(ghl.sendMessage).toHaveBeenCalledTimes(1);
    const sendCall = (
      ghl.sendMessage as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(sendCall[1]).toBe(contactId);
    expect(sendCall[2].message).toContain("confirmed");

    /* Assert GHL stage updated to Initial Consultation Scheduled */
    const stageCalls = (
      ghl.updateOpportunityStageSafe as ReturnType<typeof vi.fn>
    ).mock.calls;
    const targetStageCall = stageCalls.find(
      (call: unknown[]) =>
        call[2] === "750a6c84-d60f-424a-ac88-876d06fa362d",
    );
    expect(targetStageCall).toBeTruthy();
  });

  /* ---------------------------------------------------------------- */
  /*  Test 2 — Conversation service down, payment service completes    */
  /* ---------------------------------------------------------------- */
  it("completes booking when conversation service is down", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient({ appointment: { id: 88888 } });
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

    const contactId = "test-contact-no-conv";
    const conversationId = "550e8400-e29b-41d4-a716-446655440002";

    /* Seed conversation (created before conversation service went down) */
    await db.query(
      `INSERT INTO conversations (id, location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, $3, 'AWAITING_PAYMENT', $4, '{}')`,
      [
        conversationId,
        "loc-001",
        contactId,
        JSON.stringify({
          fullName: "Jane Doe",
          phone: "+64210000001",
          email: "jane.doe@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T10:00:00+12:00",
        }),
      ],
    );

    /* Seed payment session — conversation service is now down */
    await db.query(
      `INSERT INTO payment_sessions
       (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "cs_test_no_conv",
        "pending",
        "2026-06-20T10:00:00+12:00",
        "53224493",
        contactId,
        conversationId,
        "checkout-test-no-conv",
        JSON.stringify({
          fullName: "Jane Doe",
          phone: "+64210000001",
          email: "jane.doe@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T10:00:00+12:00",
        }),
      ],
    );

    /* Construct valid webhook event */
    const event = {
      id: "evt_no_conv",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_no_conv",
          customer_email: "jane.doe@selfcaremen.co.nz",
          metadata: {
            conversation_id: conversationId,
            service_key: "trt_initial",
            slot_iso: "2026-06-20T10:00:00+12:00",
            contact_id: contactId,
            appointment_type_id: "53224493",
            idempotency_key: "checkout-test-no-conv",
          },
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = makeStripeSignature(payload, "whsec_test");

    /* No conversation service is running; payment service handles everything */
    await service.handleWebhook(Buffer.from(payload), signature);

    /* Assert booking created */
    expect(acuity.createAppointment).toHaveBeenCalledTimes(1);

    /* Assert confirmation sent */
    expect(ghl.sendMessage).toHaveBeenCalledTimes(1);
  });

  /* ---------------------------------------------------------------- */
  /*  Test 3 — Paid patient never told unpaid, across restart          */
  /* ---------------------------------------------------------------- */
  it("does not send payment nudge to already-paid patient on restart", async () => {
    const contactId = "test-contact-paid-restart";
    const conversationId = "550e8400-e29b-41d4-a716-446655440003";

    /* Set conversation to CONFIRMED */
    await db.query(
      `INSERT INTO conversations (id, location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, $3, 'CONFIRMED', $4, '{}')`,
      [
        conversationId,
        "loc-001",
        contactId,
        JSON.stringify({
          fullName: "Bob Paid",
          phone: "+64210000002",
          email: "bob@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T11:00:00+12:00",
          _acuityAppointmentId: "55555",
          _stripeSessionId: "cs_test_paid_restart",
        }),
      ],
    );

    /* Mark payment session as paid with appointment */
    await db.query(
      `INSERT INTO payment_sessions
       (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields, acuity_appointment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        "cs_test_paid_restart",
        "paid",
        "2026-06-20T11:00:00+12:00",
        "53224493",
        contactId,
        conversationId,
        "checkout-test-restart",
        JSON.stringify({
          fullName: "Bob Paid",
          phone: "+64210000002",
          email: "bob@selfcaremen.co.nz",
          serviceKey: "trt_initial",
          slotIso: "2026-06-20T11:00:00+12:00",
        }),
        "55555",
      ],
    );

    /* Simulate a conversation service restart loading this conversation */
    const router = createMockRouter();
    const { generate } = await import("@romea/scm-flow");

    const collected = {
      fullName: "Bob Paid",
      phone: "+64210000002",
      email: "bob@selfcaremen.co.nz",
      serviceKey: "trt_initial",
      slotIso: "2026-06-20T11:00:00+12:00",
      _acuityAppointmentId: "55555",
      _stripeSessionId: "cs_test_paid_restart",
    };

    const replyText = await generate(
      "CONFIRMED",
      collected,
      [],
      undefined,
      undefined,
      { router },
    );

    /* Assert state is CONFIRMED */
    const convResult = await db.query(
      `SELECT current_state FROM conversations WHERE id = $1`,
      [conversationId],
    );
    expect(convResult.rows[0].current_state).toBe("CONFIRMED");

    /* Assert generated message is confirmation, not payment nudge */
    expect(replyText.toLowerCase()).toContain("confirmed");
    expect(replyText.toLowerCase()).not.toContain("payment");
    expect(replyText.toLowerCase()).not.toContain("unpaid");
  });

  /* ---------------------------------------------------------------- */
  /*  Test 4 — Webhook + poll fallback idempotent                     */
  /* ---------------------------------------------------------------- */
  it("calls acuity createAppointment exactly once when webhook and poll race", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient({
      appointment: { id: 99999 },
      delayMs: 100,
    });
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const contactId = "test-contact-idempotent";
    const conversationId = "550e8400-e29b-41d4-a716-446655440004";

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

    /* Fire two onPaymentConfirmed calls nearly simultaneously */
    await Promise.all([
      onPaymentConfirmed(stripeSession, deps),
      onPaymentConfirmed(stripeSession, deps),
    ]);

    /* Assert createAppointment called exactly once */
    expect(acuity.createAppointment).toHaveBeenCalledTimes(1);

    /* Assert exactly one confirmation message sent */
    expect(ghl.sendMessage).toHaveBeenCalledTimes(1);
  });

  /* ---------------------------------------------------------------- */
  /*  Test 5 — Invalid webhook signature rejected                      */
  /* ---------------------------------------------------------------- */
  it("rejects invalid webhook signature with 400", async () => {
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
      data: {
        object: { id: "cs_test_bad", customer_email: "bad@example.com" },
      },
    };
    const payload = JSON.stringify(event);
    const badSignature = makeStripeSignature(payload, "wrong_secret");

    await expect(
      service.handleWebhook(Buffer.from(payload), badSignature),
    ).rejects.toBeInstanceOf(WebhookError);

    /* Assert no side effects */
    expect(acuity.createAppointment).not.toHaveBeenCalled();
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- */
  /*  Test 6 — Crash after booking, before confirmation send           */
  /* ---------------------------------------------------------------- */
  it("recovers and sends confirmation after crash between booking and send", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient({ appointment: { id: 123 } });
    const stripe = createMockStripeClient();
    const router = createMockRouter();

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

    /* Mock GHL send to throw on first call (simulates crash) */
    let sendAttempts = 0;
    (ghl.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_loc: string, _cid: string, _payload: unknown) => {
      sendAttempts++;
      if (sendAttempts === 1) {
        throw new Error("Simulated GHL crash");
      }
    });

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

    /* Assert payment_sessions.status = 'paid' and acuity_appointment_id = 'appt-123' */
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
    await recoverUnsentReplies(db, (locationId, contactId, payload) =>
      ghl.sendMessage(locationId, contactId, payload),
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
});
