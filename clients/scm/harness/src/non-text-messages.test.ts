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
import { ConversationService } from "../../service/src/conversation-service.js";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import type { ModelRouter } from "@romea/model-router";
import { createMockGhlClient } from "./mocks/ghl-mock.js";

config({ path: resolve(process.cwd(), "clients/scm/.env") });

const fixturePath = resolve(process.cwd(), "clients/scm/harness/fixtures/ghl-real-inbound-payload.json");
const basePayload = JSON.parse(readFileSync(fixturePath, "utf-8"));

const DATABASE_URL = process.env.DATABASE_URL ?? "";



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

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(basePayload),
    location_id: "test-loc-001",
    contact_id: "test-contact-001",
    ...overrides,
  };
}

/**
 * Consolidated regression test: non-text inbound messages.
 *
 * - Empty body system events → ignored, no state change
 * - Malformed payloads → ignored, no crash
 * - Image/attachment → escalated to HUMAN_TOUCH + image-handoff reply
 */
describe("non-text messages — consolidated regression", () => {
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

  it("ignores system event with empty body", async () => {
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

    const result = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-malformed",
        message: {
          id: "mal-1",
          body: undefined as unknown as string,
          direction: "inbound",
          type: "UNKNOWN",
        },
      }),
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBe("ignored:malformed");
    expect(ghl.sendMessage).not.toHaveBeenCalled();
  });

  it("escalates image/attachment with empty body to human and sends image-handoff reply", async () => {
    const ghl = createMockGhlClient();
    (ghl.getPipelineOpportunities as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "opp-img",
        pipelineId: "pipe-001",
        pipelineStageId: "26763fc3-9013-42f6-a3cd-b254bf61f467",
        contactId: "test-contact-image",
      },
    ]);
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

    const result = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-image",
        message: {
          id: "img-1",
          body: "",
          direction: "inbound",
          type: "image",
        },
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
    const stageCalls = (
      ghl.updateOpportunityStageSafe as ReturnType<typeof vi.fn>
    ).mock.calls;
    const humanTouchCall = stageCalls.find(
      (call: unknown[]) => call[2] === "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4",
    );
    expect(humanTouchCall).toBeTruthy();
  });

  it("does not crash on id-without-body variants", async () => {
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

    /* SMS with empty body */
    const r1 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-empty-1",
        message: { id: "empty-1", body: "", direction: "inbound", type: "SMS" },
      }),
    );
    expect(r1.sent).toBe(false);

    /* Email with undefined body */
    const r2 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-empty-2",
        message: {
          id: "empty-2",
          body: undefined as unknown as string,
          direction: "inbound",
          type: "email",
        },
      }),
    );
    expect(r2.sent).toBe(false);

    /* Attachment with empty body → image path sends reply */
    const r3 = await service.handleInbound(
      makePayload({
        contact_id: "test-contact-empty-3",
        message: {
          id: "empty-3",
          body: "",
          direction: "inbound",
          type: "attachment",
        },
      }),
    );
    expect(r3.sent).toBe(true);
  });
});
