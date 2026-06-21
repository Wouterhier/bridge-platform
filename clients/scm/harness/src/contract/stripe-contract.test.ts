// @contract - runs only with REAL_STRIPE_TEST=true env var
// Usage: REAL_STRIPE_TEST=true npx vitest run clients/scm/harness/src/contract/

import { describe, it, expect, beforeAll } from "vitest";
import { createStripeClient } from "@romea/stripe-client";

const SKIP = !process.env.REAL_STRIPE_TEST;

describe.skipIf(SKIP)("Stripe contract tests (real API)", () => {
  let stripe: ReturnType<typeof createStripeClient>;

  beforeAll(() => {
    stripe = createStripeClient({ secretKey: process.env.STRIPE_SECRET_KEY! });
  });

  it("creates a checkout session", async () => {
    const session = await stripe.createCheckoutSession({
      successUrl: "https://selfcaremen.co.nz/success",
      cancelUrl: "https://selfcaremen.co.nz/cancel",
      lineItems: [
        {
          amount: 1000,
          currency: "nzd",
          name: "Contract Test",
        },
      ],
      clientReferenceId: `contract-test-${Date.now()}`,
    });

    expect(session.id).toMatch(/^cs_(test|live)_/);
    expect(session.url).toContain("stripe.com");
  });

  it("retrieves a checkout session", async () => {
    const created = await stripe.createCheckoutSession({
      successUrl: "https://selfcaremen.co.nz/success",
      cancelUrl: "https://selfcaremen.co.nz/cancel",
      lineItems: [
        {
          amount: 1000,
          currency: "nzd",
          name: "Contract Test",
        },
      ],
      clientReferenceId: `contract-test-${Date.now()}`,
    });

    const fetched = await stripe.getCheckoutSession(created.id);
    expect(fetched.id).toBe(created.id);
  });
});
