import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createStripeClient, type CheckoutSessionPayload } from "./stripe-client.js";
import { createHmac } from "node:crypto";

function makeStripeSignature(payload: string, secret: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${t}.${payload}`;
  const signature = createHmac("sha256", secret).update(signedPayload).digest("hex");
  return `t=${t},v1=${signature}`;
}

describe("stripe-client", () => {
  const secretKey = "sk_test_123";

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("createCheckoutSession returns session with id and url", async () => {
    const client = createStripeClient({ secretKey });
    const mockSession = { id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123", status: "open" };
    vi.spyOn(client.stripe.checkout.sessions, "create").mockResolvedValue(mockSession as never);

    const payload: CheckoutSessionPayload = {
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
      lineItems: [{ amount: 17900, currency: "nzd", name: "TRT Initial Consultation", quantity: 1 }],
    };

    const result = await client.createCheckoutSession(payload);
    expect(result).toEqual({ id: "cs_test_123", url: "https://checkout.stripe.com/pay/cs_test_123", status: "open" });
    expect(client.stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        success_url: "https://example.com/success",
        cancel_url: "https://example.com/cancel",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "nzd",
              unit_amount: 17900,
              product_data: { name: "TRT Initial Consultation" },
            },
          },
        ],
      }),
    );
  });

  it("getCheckoutSession returns session", async () => {
    const client = createStripeClient({ secretKey });
    const mockSession = { id: "cs_test_123", status: "complete" };
    vi.spyOn(client.stripe.checkout.sessions, "retrieve").mockResolvedValue(mockSession as never);

    const result = await client.getCheckoutSession("cs_test_123");
    expect(result).toEqual(mockSession);
  });

  it("listLineItems returns line items", async () => {
    const client = createStripeClient({ secretKey });
    const mockList = { data: [{ id: "li_1", description: "TRT Initial Consultation", amount_total: 17900 }] };
    vi.spyOn(client.stripe.checkout.sessions, "listLineItems").mockResolvedValue(mockList as never);

    const result = await client.listLineItems("cs_test_123");
    expect(result).toEqual(mockList);
  });

  it("accepts correctly signed webhook", () => {
    const webhookSecret = "whsec_test_123";
    const client = createStripeClient({ secretKey });
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_123" } } };
    const payload = JSON.stringify(event);
    const signature = makeStripeSignature(payload, webhookSecret);

    const result = client.constructWebhookEvent(payload, signature, webhookSecret);
    expect(result.id).toBe("evt_1");
    expect(result.type).toBe("checkout.session.completed");
  });

  it("rejects unsigned webhook POST", () => {
    const webhookSecret = "whsec_test_123";
    const client = createStripeClient({ secretKey });
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_123" } } };
    const payload = JSON.stringify(event);

    expect(() => client.constructWebhookEvent(payload, "", webhookSecret)).toThrow();
  });

  it("constructWebhookEvent rejects an invalid signature", () => {
    const webhookSecret = "whsec_test_123";
    const client = createStripeClient({ secretKey });
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_123" } } };
    const payload = JSON.stringify(event);
    const signature = makeStripeSignature(payload, "wrong_secret");

    expect(() => client.constructWebhookEvent(payload, signature, webhookSecret)).toThrow();
  });

  it("constructWebhookEvent rejects a tampered payload", () => {
    const webhookSecret = "whsec_test_123";
    const client = createStripeClient({ secretKey });
    const event = { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_123" } } };
    const payload = JSON.stringify(event);
    const signature = makeStripeSignature(payload, webhookSecret);
    const tampered = payload.replace("cs_test_123", "cs_test_999");

    expect(() => client.constructWebhookEvent(tampered, signature, webhookSecret)).toThrow();
  });
});
