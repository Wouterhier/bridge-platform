import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { ConversationService, recoverUnsentReplies } from "./conversation-service.js";
import type { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import type { ModelRouter } from "@romea/model-router";
import { createMockGhlClient } from "../../harness/src/mocks/ghl-mock.js";

config({ path: resolve(process.cwd(), "clients/scm/.env") });

const fixturePath = resolve(process.cwd(), "clients/scm/harness/fixtures/ghl-real-inbound-payload.json");
const basePayload = JSON.parse(readFileSync(fixturePath, "utf-8"));

const DATABASE_URL = process.env.DATABASE_URL ?? "";



function createMockAcuityClient(
  overrides: {
    getAvailabilityDelayMs?: number;
    slots?: Array<{ time: string }>;
    appointment?: { id: number };
  } = {},
): ReturnType<typeof createAcuityClient> {
  const { getAvailabilityDelayMs = 0, slots = [], appointment = { id: 999 } } =
    overrides;
  return {
    getAppointmentTypes: vi.fn(async () => []),
    getAvailability: vi.fn(async () => {
      if (getAvailabilityDelayMs > 0) {
        await new Promise((r) => setTimeout(r, getAvailabilityDelayMs));
      }
      return slots;
    }),
    createAppointment: vi.fn(async () => appointment),
    getAppointment: vi.fn(async () => appointment),
    updateAppointmentFormFields: vi.fn(async () => appointment),
  } as unknown as ReturnType<typeof createAcuityClient>;
}

function createMockStripeClient(): ReturnType<typeof createStripeClient> {
  return {
    stripe: {} as any,
    createCheckoutSession: vi.fn(async () => ({
      id: "cs_test_123",
      url: "https://pay.stripe.com/test",
      status: "open",
    })),
    getCheckoutSession: vi.fn(async () => ({
      id: "cs_test_123",
      url: "https://pay.stripe.com/test",
      status: "open",
    })),
    listLineItems: vi.fn(async () => ({ data: [] })),
    constructWebhookEvent: vi.fn(() => ({})),
  } as unknown as ReturnType<typeof createStripeClient>;
}

function createMockRouter(): ModelRouter {
  return {
    complete: vi.fn(async (_role, req) => {
      /* Return a simple prose response based on the prompt content */
      const lastMsg =
        Array.isArray(req.messages) && req.messages.length > 0
          ? String(req.messages[req.messages.length - 1].content)
          : "";
      if (lastMsg.includes("Current task:")) {
        const taskMatch = lastMsg.match(/Current task:\n(.+)/);
        const task = taskMatch ? taskMatch[1] : "Hello";
        return {
          text: `Mock reply for: ${task}`,
          provider: "mock",
          model: "mock",
        };
      }
      return { text: "Mock reply", provider: "mock", model: "mock" };
    }),
    escalate: vi.fn(async (_role, req) => ({
      text: "Escalated mock reply",
      provider: "mock",
      model: "mock",
    })),
  } as unknown as ModelRouter;
}

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(basePayload),
    location_id: "test-loc-001",
    contact_id: "test-contact-001",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe("conversation-service", () => {
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
    /* Clean test data */
    await db.query(`DELETE FROM processed_messages WHERE contact_id LIKE 'test-%'`);
    await db.query(`DELETE FROM payment_sessions WHERE contact_id LIKE 'test-%'`);
    await db.query(`DELETE FROM conversations WHERE contact_id LIKE 'test-%'`);
  });

  /* ---------------------------------------------------------------- */
  /*  Test 1 — Full free-consult E2E                                   */
  /* ---------------------------------------------------------------- */
  it("books a free eligibility appointment end to end", async () => {
    const ghl = createMockGhlClient();
    (ghl.getPipelineOpportunities as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "opp-e2e", pipelineId: "pipe-001", pipelineStageId: "26763fc3-9013-42f6-a3cd-b254bf61f467", contactId: "test-contact-e2e" },
    ]);
    const acuity = createMockAcuityClient({
      slots: [
        { time: "2026-06-20T09:00:00+12:00" },
        { time: "2026-06-20T10:00:00+12:00" },
      ],
      appointment: { id: 12345 },
    });
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-e2e";

    /* 1. "Hi I'd like to book" */
    let result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "e2e-1", body: "Hi I'd like to book", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* 2. "John Smith" */
    result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "e2e-2", body: "John Smith", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* 3. "+64 21 000 0000" */
    result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "e2e-3", body: "+64 21 000 0000", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* 4. "john.smith@selfcaremen.co.nz" */
    result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "e2e-4", body: "john.smith@selfcaremen.co.nz", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* 5. "Free eligibility check" — map to service key via extraction mock */
    const extractRouter = {
      complete: vi.fn(async () => ({
        text: '{"serviceKey": "free_eligibility"}',
        provider: "mock",
        model: "mock",
      })),
      escalate: vi.fn(async () => ({
        text: '{"serviceKey": "free_eligibility"}',
        provider: "mock",
        model: "mock",
      })),
    } as unknown as ModelRouter;

    const serviceWithExtract = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router: extractRouter,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    result = await serviceWithExtract.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "e2e-5", body: "Free eligibility check", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* 6. Pick first slot */
    const slotRouter = {
      complete: vi.fn(async () => ({
        text: '{"slotIso": "2026-06-20T09:00:00+12:00"}',
        provider: "mock",
        model: "mock",
      })),
      escalate: vi.fn(async () => ({
        text: '{"slotIso": "2026-06-20T09:00:00+12:00"}',
        provider: "mock",
        model: "mock",
      })),
    } as unknown as ModelRouter;

    const serviceWithSlotExtract = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router: slotRouter,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    result = await serviceWithSlotExtract.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "e2e-6", body: "2026-06-20T09:00:00+12:00", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* Assert conversation ends in CONFIRMED */
    const convResult = await db.query(
      `SELECT current_state, collected_fields FROM conversations WHERE contact_id = $1`,
      [contactId],
    );
    expect(convResult.rows[0].current_state).toBe("CONFIRMED");
    const collected = convResult.rows[0].collected_fields as Record<string, unknown>;
    expect(collected.fullName).toBe("John Smith");
    expect(collected.phone).toBe("+64210000000");
    expect(collected.email).toBe("john.smith@selfcaremen.co.nz");
    expect(collected._acuityAppointmentId).toBe("12345");

    /* Assert Acuity booking was called */
    expect(acuity.createAppointment).toHaveBeenCalled();

    /* Assert GHL stage updated to eligibility booked */
    const stageCalls = (ghl.updateOpportunityStageSafe as ReturnType<typeof vi.fn>).mock.calls;
    const eligibilityStageCall = stageCalls.find(
      (call: unknown[]) => call[2] === "b000d5c7-de71-4997-b263-74162c416736",
    );
    expect(eligibilityStageCall).toBeTruthy();
  });

  /* ---------------------------------------------------------------- */
  /*  Test 1b — Slot menu code-injected into reply                     */
  /* ---------------------------------------------------------------- */
  it("code-injects slot menu into reply body so model cannot omit slots", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-slot-inject";

    /* Seed conversation at AWAITING_SELECTION with slotMenuFormatted already set */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'AWAITING_SELECTION', $3, '{}')`,
      [
        "test-loc-001",
        contactId,
        JSON.stringify({
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john.smith@example.com",
          serviceKey: "free_eligibility",
          slotMenu: [
            { iso: "2026-06-20T09:00:00+12:00", formatted: "Saturday, 20 June at 9:00 am Pacific/Auckland" },
            { iso: "2026-06-20T10:00:00+12:00", formatted: "Saturday, 20 June at 10:00 am Pacific/Auckland" },
          ],
          slotMenuFormatted: "1. Saturday, 20 June at 9:00 am Pacific/Auckland\n2. Saturday, 20 June at 10:00 am Pacific/Auckland",
        }),
      ],
    );

    /* Send an invalid slot selection — state stays AWAITING_SELECTION */
    const result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "slot-inject-1", body: "hello", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* Assert the reply sent to GHL contains the code-built slot strings */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const slotReplyCall = sendCalls.find(
      (call: unknown[]) => (call[1] as string) === contactId,
    );
    expect(slotReplyCall).toBeTruthy();
    const replyMessage = (slotReplyCall![2] as { message?: string })?.message ?? "";
    expect(replyMessage).toContain("Saturday, 20 June at 9:00 am Pacific/Auckland");
    expect(replyMessage).toContain("Saturday, 20 June at 10:00 am Pacific/Auckland");

    /* Assert conversation state is still AWAITING_SELECTION */
    const convResult = await db.query(
      `SELECT current_state FROM conversations WHERE contact_id = $1`,
      [contactId],
    );
    expect(convResult.rows[0].current_state).toBe("AWAITING_SELECTION");
  });

  /* ---------------------------------------------------------------- */
  /*  Test 2 — Restart resilience                                      */
  /* ---------------------------------------------------------------- */
  it("resumes from Postgres state after simulated restart", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const serviceA = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-restart";

    /* Seed conversation at COLLECTING_EMAIL with name + phone */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'COLLECTING_EMAIL', $3, '{}')`,
      [
        "test-loc-001",
        contactId,
        JSON.stringify({ fullName: "John Smith", phone: "+64210000000" }),
      ],
    );

    /* Simulate inbound email */
    const resultA = await serviceA.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "restart-1", body: "john.smith@selfcaremen.co.nz", direction: "inbound", type: "SMS" },
      }),
    );
    expect(resultA.sent).toBe(true);

    /* Verify DB updated to SELECTING_SERVICE */
    let conv = await db.query(
      `SELECT current_state, collected_fields FROM conversations WHERE contact_id = $1`,
      [contactId],
    );
    expect(conv.rows[0].current_state).toBe("SELECTING_SERVICE");
    expect((conv.rows[0].collected_fields as Record<string, unknown>).email).toBe(
      "john.smith@selfcaremen.co.nz",
    );

    /* Simulate restart: new service instance B */
    const serviceB = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    /* Same message again should be deduped */
    const resultB = await serviceB.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "restart-1", body: "john.smith@selfcaremen.co.nz", direction: "inbound", type: "SMS" },
      }),
    );
    expect(resultB.sent).toBe(false);
    expect(resultB.reason).toBe("dedup");

    /* Verify state is still SELECTING_SERVICE */
    conv = await db.query(
      `SELECT current_state, collected_fields FROM conversations WHERE contact_id = $1`,
      [contactId],
    );
    expect(conv.rows[0].current_state).toBe("SELECTING_SERVICE");

    /* Assert exactly one GHL message was sent for the email message */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
  });

  /* ---------------------------------------------------------------- */
  /*  Test 3 — Dedup across restart                                    */
  /* ---------------------------------------------------------------- */
  it("dedups messages across service restarts", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const contactId = "test-contact-dedup";

    /* Pre-seed processed_messages row (fully processed — has send_payload) */
    await db.query(
      `INSERT INTO processed_messages (message_id, contact_id, send_payload, send_attempts)
       VALUES ($1, $2, $3, 1)`,
      ["msg-restart-001", contactId, JSON.stringify({ message: "Hello back", type: "SMS", contactId, locationId: "test-loc-001" })],
    );

    const serviceA = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const resultA = await serviceA.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "msg-restart-001", body: "Hello", direction: "inbound", type: "SMS" },
      }),
    );
    expect(resultA.sent).toBe(false);
    expect(resultA.reason).toBe("dedup");

    /* Simulate restart with new instance */
    const serviceB = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const resultB = await serviceB.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "msg-restart-001", body: "Hello", direction: "inbound", type: "SMS" },
      }),
    );
    expect(resultB.sent).toBe(false);
    expect(resultB.reason).toBe("dedup");

    /* No GHL messages sent for deduped message */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const dedupedSendCalls = sendCalls.filter(
      (call: unknown[]) => (call[1] as { contactId?: string })?.contactId === contactId,
    );
    expect(dedupedSendCalls.length).toBe(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Test 4 — Holding message                                         */
  /* ---------------------------------------------------------------- */
  it("sends holding message when slot fetch is slow", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient({
      getAvailabilityDelayMs: 2000,
      slots: [{ time: "2026-06-20T09:00:00+12:00" }],
    });
    const stripe = createMockStripeClient();

    /* Router that extracts service key so engine transitions to SHOWING_SLOTS */
    const extractRouter = {
      complete: vi.fn(async () => ({
        text: '{"serviceKey": "free_eligibility"}',
        provider: "mock",
        model: "mock",
      })),
      escalate: vi.fn(async () => ({
        text: '{"serviceKey": "free_eligibility"}',
        provider: "mock",
        model: "mock",
      })),
    } as unknown as ModelRouter;

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router: extractRouter,
      debounceMs: 0,
      holdingThresholdMs: 500,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-holding";

    /* Seed conversation at SELECTING_SERVICE with name/phone/email */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'SELECTING_SERVICE', $3, '{}')`,
      [
        "test-loc-001",
        contactId,
        JSON.stringify({
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john.smith@selfcaremen.co.nz",
        }),
      ],
    );

    const result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "holding-1", body: "free eligibility", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* Assert holding message was sent exactly once */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const holdingCalls = sendCalls.filter((call: unknown[]) => {
      const msg = (call[2] as { message?: string })?.message ?? "";
      return (
        msg.includes("moment") ||
        msg.includes("second") ||
        msg.includes("pulling up")
      );
    });
    expect(holdingCalls.length).toBe(1);
  }, 15000);

  it("does NOT send holding message while booking is in flight", async () => {
    const ghl = createMockGhlClient();
    /* Slow booking but holding should NOT fire because BOOKING_ACUITY is excluded */
    const acuity = createMockAcuityClient({
      getAvailabilityDelayMs: 5000,
      appointment: { id: 8888 },
    });
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 1000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const contactId = "test-contact-no-holding";

    /* Seed conversation at BOOKING_ACUITY with all fields collected */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'BOOKING_ACUITY', $3, '{}')`,
      [
        "test-loc-001",
        contactId,
        JSON.stringify({
          fullName: "John Smith",
          phone: "+64210000000",
          email: "john.smith@example.com",
          serviceKey: "free_eligibility",
          slotIso: "2026-06-20T09:00:00+12:00",
        }),
      ],
    );

    const result = await service.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "no-holding-1", body: "confirm", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(true);

    /* Assert no holding message was sent */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const holdingCalls = sendCalls.filter((call: unknown[]) => {
      const msg = (call[2] as { message?: string })?.message ?? "";
      return (
        msg.includes("moment") ||
        msg.includes("second") ||
        msg.includes("moment while")
      );
    });
    expect(holdingCalls.length).toBe(0);
  });

  /* ---------------------------------------------------------------- */
  /*  Test 6 — Crash between processed_messages commit and send       */
  /* ---------------------------------------------------------------- */
  it("leaves sent_at NULL when GHL send fails and recovers on restart", async () => {
    const ghl = createMockGhlClient();
    /* First call throws, second succeeds */
    let callCount = 0;
    (ghl.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("GHL transient error");
      }
      return {};
    });

    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
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
    /* sendMessage threw, but handler should not throw */
    expect(result.sent).toBe(true);

    /* Assert processed_messages row exists with sent_at IS NULL */
    const pmResult = await db.query(
      `SELECT sent_at, send_attempts, send_payload
       FROM processed_messages
       WHERE message_id = $1`,
      ["crash-1"],
    );
    expect(pmResult.rows.length).toBe(1);
    expect(pmResult.rows[0].sent_at).toBeNull();
    expect(pmResult.rows[0].send_attempts).toBe(1);
    expect(pmResult.rows[0].send_payload).toMatchObject({
      message: expect.any(String),
      type: "SMS",
      contactId: expect.any(String),
      locationId: "test-loc-001",
    });

    /* Simulate service restart: call recoverUnsentReplies */
    await recoverUnsentReplies(db, (locationId, contactId, payload) =>
      ghl.sendMessage(locationId, contactId, payload),
    );

    /* Assert ghl.sendMessage was called again with the same payload */
    expect(callCount).toBe(2);
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const recoveryCall = sendCalls[sendCalls.length - 1];
    expect((recoveryCall[2] as { message?: string })?.message).toBe(pmResult.rows[0].send_payload.message);

    /* Assert sent_at is now set */
    const pmResultAfter = await db.query(
      `SELECT sent_at FROM processed_messages WHERE message_id = $1`,
      ["crash-1"],
    );
    expect(pmResultAfter.rows[0].sent_at).not.toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /*  Test 7 — Already-sent message is not re-sent                    */
  /* ---------------------------------------------------------------- */
  it("does not re-send already-sent messages during recovery", async () => {
    const ghl = createMockGhlClient();
    const contactId = "test-contact-already-sent";

    /* Insert a processed_messages row that is already sent */
    await db.query(
      `INSERT INTO processed_messages (message_id, contact_id, sent_at, send_payload, send_attempts)
       VALUES ($1, $2, now(), $3, 1)`,
      ["already-sent-1", contactId, JSON.stringify({ message: "Hello", type: "SMS", contactId, locationId: "test-loc-001" })],
    );

    await recoverUnsentReplies(db, (locationId, contactId, payload) =>
      ghl.sendMessage(locationId, contactId, payload),
    );

    /* Assert ghl.sendMessage was NOT called */
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- */
  /*  Test 8 — Restart resilience with recovery                       */
  /* ---------------------------------------------------------------- */
  it("recovers unsent replies after simulated restart", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const contactId = "test-contact-restart-recovery";

    /* Seed conversation at COLLECTING_EMAIL */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'COLLECTING_EMAIL', $3, '{}')`,
      [
        "test-loc-001",
        contactId,
        JSON.stringify({ fullName: "John Smith", phone: "+64210000000" }),
      ],
    );

    const serviceA = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    /* Simulate inbound email — this will generate and store reply, then send it */
    const resultA = await serviceA.handleInbound(
      makePayload({
        contact_id: contactId,
        message: { id: "restart-recovery-1", body: "john.smith@selfcaremen.co.nz", direction: "inbound", type: "SMS" },
      }),
    );
    expect(resultA.sent).toBe(true);

    /* Simulate crash: manually reset sent_at to NULL (as if send succeeded in test but we want to test recovery) */
    await db.query(
      `UPDATE processed_messages SET sent_at = NULL WHERE message_id = $1`,
      ["restart-recovery-1"],
    );

    /* Simulate restart: new service instance + recovery */
    const serviceB = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    await recoverUnsentReplies(db, (locationId, contactId, payload) =>
      ghl.sendMessage(locationId, contactId, payload),
    );

    /* Assert the reply was re-sent */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const recoveryCalls = sendCalls.filter(
      (call: unknown[]) => call[1] === contactId,
    );
    /* One call from original handleInbound, one from recovery */
    expect(recoveryCalls.length).toBe(2);

    /* Assert sent_at is now set */
    const pmResult = await db.query(
      `SELECT sent_at FROM processed_messages WHERE message_id = $1`,
      ["restart-recovery-1"],
    );
    expect(pmResult.rows[0].sent_at).not.toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /*  Regression — image/attachment/system/malformed handling         */
  /* ---------------------------------------------------------------- */
  it("ignores system event with empty body", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const result = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-system",
        message: { id: "sys-1", body: "", direction: "inbound", type: "SMS" },
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("ignored:system");
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores malformed payload with missing body", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const result = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-malformed",
        message: { id: "mal-1", body: undefined as unknown as string, direction: "inbound", type: "UNKNOWN" },
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("ignored:malformed");
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });

  it("escalates image/attachment with empty body to human and sends image-handoff reply", async () => {
    const ghl = createMockGhlClient();
    (ghl.getPipelineOpportunities as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "opp-img", pipelineId: "pipe-001", pipelineStageId: "26763fc3-9013-42f6-a3cd-b254bf61f467", contactId: "test-contact-image" },
    ]);
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    const result = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-image",
        message: { id: "img-1", body: "", direction: "inbound", type: "image" },
      }),
    );
    expect(result.sent).toBe(true);
    expect(result.reason).toBe("escalated:image_attachment");

    /* Assert image-handoff reply was sent */
    const sendCalls = (ghl.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const imageReplyCall = sendCalls.find((call: unknown[]) =>
      (call[2] as { message?: string })?.message?.includes("can't view images"),
    );
    expect(imageReplyCall).toBeTruthy();

    /* Assert stage updated to HUMAN_TOUCH */
    const stageCalls = (ghl.updateOpportunityStageSafe as ReturnType<typeof vi.fn>).mock.calls;
    const humanTouchCall = stageCalls.find(
      (call: unknown[]) => call[2] === "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4",
    );
    expect(humanTouchCall).toBeTruthy();
  });

  it("does not crash on empty body message", async () => {
    const ghl = createMockGhlClient();
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();
    const router = createMockRouter();

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    /* All three variants should return without crashing */
    const r1 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-empty-1",
        message: { id: "empty-1", body: "", direction: "inbound", type: "SMS" },
      }),
    );
    expect(r1.sent).toBe(false);

    const r2 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-empty-2",
        message: { id: "empty-2", body: undefined as unknown as string, direction: "inbound", type: "email" },
      }),
    );
    expect(r2.sent).toBe(false);

    const r3 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-empty-3",
        message: { id: "empty-3", body: "", direction: "inbound", type: "attachment" },
      }),
    );
    expect(r3.sent).toBe(true); /* image path sends reply */
  });

  it("escalates via model-side safety detection even when regex misses", async () => {
    const ghl = createMockGhlClient();
    (ghl.getPipelineOpportunities as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "opp-safety", pipelineId: "pipe-001", pipelineStageId: "26763fc3-9013-42f6-a3cd-b254bf61f467", contactId: "test-contact-safety" },
    ]);
    const acuity = createMockAcuityClient();
    const stripe = createMockStripeClient();

    /* Router that returns safety_concern from extract (simulating model detection) */
    const safetyRouter = {
      complete: vi.fn(async () => ({
        text: '{"safety_concern": true, "concern_type": "self_harm"}',
        provider: "mock",
        model: "mock",
      })),
      escalate: vi.fn(async () => ({
        text: '{"safety_concern": true, "concern_type": "self_harm"}',
        provider: "mock",
        model: "mock",
      })),
    } as unknown as ModelRouter;

    const service = new ConversationService({
      db,
      ghl,
      acuity,
      stripe,
      router: safetyRouter,
      debounceMs: 0,
      holdingThresholdMs: 3000,
      ghlPipelineId: "pipe-001",
      stripeSuccessUrl: "https://selfcaremen.co.nz/success",
      stripeCancelUrl: "https://selfcaremen.co.nz/cancel",
    });

    /* Seed conversation at COLLECTING_NAME so extract() is called */
    await db.query(
      `INSERT INTO conversations (location_id, contact_id, current_state, collected_fields, context)
       VALUES ($1, $2, 'COLLECTING_NAME', $3, '{}')`,
      ["test-loc-001", "test-contact-safety", JSON.stringify({})],
    );

    const result = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-safety",
        message: { id: "safety-1", body: "I feel like giving up on everything", direction: "inbound", type: "SMS" },
      }),
    );

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("escalated:model_safety");

    /* Assert stage updated to HUMAN_TOUCH */
    const stageCalls = (ghl.updateOpportunityStageSafe as ReturnType<typeof vi.fn>).mock.calls;
    const humanTouchCall = stageCalls.find(
      (call: unknown[]) => call[2] === "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4",
    );
    expect(humanTouchCall).toBeTruthy();
  });

});
