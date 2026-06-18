import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createGhlClient, createShadowGhlClient } from "@romea/ghl-client";
import { createAcuityClient, createShadowAcuityClient } from "@romea/acuity-client";
import { createStripeClient, createShadowStripeClient } from "@romea/stripe-client";

describe("shadow isolation — client factories never read env vars", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /* ── GHL ── */
  describe("ghl client", () => {
    it("real client calls fetch on sendMessage", async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const ghl = createGhlClient({ token: "test-pit" });
      await ghl.sendMessage("loc1", "c1", { message: "hello", channel: "sms" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = String((fetchSpy.mock.calls[0] as unknown[])[0]);
      expect(url).toContain("/conversations/messages");
    });

    it("shadow client does NOT call fetch and returns shadowSkipped", async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({}), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const ghl = createShadowGhlClient({ token: "test-pit" });
      const result = await ghl.sendMessage("loc1", "c1", {
        message: "hello",
        channel: "sms",
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ shadowSkipped: true });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logEntry.shadow).toBe(true);
      expect(logEntry.action).toBe("ghl.sendMessage");

      consoleSpy.mockRestore();
    });
  });

  /* ── Acuity ── */
  describe("acuity client", () => {
    it("real client calls fetch on createAppointment", async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({ id: 123 }), { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const acuity = createAcuityClient({
        userId: "user_123",
        apiKey: "key_456",
      });
      await acuity.createAppointment({
        appointmentTypeID: 79429909,
        datetime: "2026-06-20T10:00:00",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = String((fetchSpy.mock.calls[0] as unknown[])[0]);
      expect(url).toContain("/appointments");
    });

    it("shadow client does NOT call fetch and returns stub appointment", async () => {
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify({}), { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const acuity = createShadowAcuityClient({
        userId: "user_123",
        apiKey: "key_456",
      });
      const result = await acuity.createAppointment({
        appointmentTypeID: 79429909,
        datetime: "2026-06-20T10:00:00",
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.id).toBe(999999);

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logEntry.shadow).toBe(true);
      expect(logEntry.action).toBe("acuity.createAppointment");

      consoleSpy.mockRestore();
    });
  });

  /* ── Stripe ── */
  describe("stripe client", () => {
    it("real client calls stripe.checkout.sessions.create", async () => {
      const client = createStripeClient({ secretKey: "sk_test_123" });
      const createSpy = vi
        .spyOn(client.stripe.checkout.sessions, "create")
        .mockResolvedValue({
          id: "cs_real",
          url: "https://checkout.stripe.com/real",
          status: "open",
        } as never);

      await client.createCheckoutSession({
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        lineItems: [{ amount: 17900, currency: "nzd", name: "Test", quantity: 1 }],
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      createSpy.mockRestore();
    });

    it("shadow client does NOT call stripe.create and returns stub", async () => {
      const client = createShadowStripeClient({ secretKey: "sk_test_123" });
      const createSpy = vi
        .spyOn(client.stripe.checkout.sessions, "create")
        .mockResolvedValue({} as never);

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await client.createCheckoutSession({
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        lineItems: [{ amount: 17900, currency: "nzd", name: "Test", quantity: 1 }],
      });

      expect(createSpy).not.toHaveBeenCalled();
      expect(result.id).toBe("shadow-session-id");

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const logEntry = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(logEntry.shadow).toBe(true);
      expect(logEntry.action).toBe("stripe.createCheckoutSession");

      createSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });
});
