import { readFileSync } from "node:fs";
import Stripe from "stripe";

export interface StripeClientConfig {
  secretKey: string;
  apiVersion?: Stripe.LatestApiVersion;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface CheckoutSessionPayload {
  mode?: Stripe.Checkout.SessionCreateParams.Mode;
  successUrl: string;
  cancelUrl: string;
  lineItems: Array<{
    price?: string;
    quantity?: number;
    amount?: number;
    currency?: string;
    name?: string;
  }>;
  customerEmail?: string;
  clientReferenceId?: string;
  metadata?: Record<string, string>;
  paymentIntentData?: { receipt_email?: string };
  [key: string]: unknown;
}

export interface CheckoutSessionResult {
  id: string;
  url: string | null;
  status: string | null;
  [key: string]: unknown;
}

export function createStripeClient(config: StripeClientConfig) {
  const stripe = new Stripe(config.secretKey, {
    apiVersion: config.apiVersion ?? "2025-02-24.acacia",
  });

  return {
    stripe,

    async createCheckoutSession(
      payload: CheckoutSessionPayload,
    ): Promise<CheckoutSessionResult> {
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] =
        payload.lineItems.map((item) => {
          if (item.price) {
            return { price: item.price, quantity: item.quantity ?? 1 };
          }
          return {
            quantity: item.quantity ?? 1,
            price_data: {
              currency: item.currency ?? "nzd",
              unit_amount: item.amount,
              product_data: { name: item.name ?? "Consultation" },
            },
          };
        });

      const session = await stripe.checkout.sessions.create({
        mode: payload.mode ?? "payment",
        success_url: payload.successUrl,
        cancel_url: payload.cancelUrl,
        line_items: lineItems,
        customer_email: payload.customerEmail,
        client_reference_id: payload.clientReferenceId,
        metadata: payload.metadata,
        payment_intent_data: payload.paymentIntentData,
      });

      return {
        id: session.id,
        url: session.url,
        status: session.status,
      };
    },

    async getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
      return stripe.checkout.sessions.retrieve(sessionId);
    },

    async listLineItems(
      sessionId: string,
      params?: Stripe.Checkout.SessionListLineItemsParams,
    ): Promise<Stripe.ApiList<Stripe.LineItem>> {
      return stripe.checkout.sessions.listLineItems(sessionId, params);
    },

    constructWebhookEvent(
      payload: string | Buffer,
      signature: string,
      secret: string,
    ): Stripe.Event {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    },
  };
}

export function createShadowStripeClient(config: StripeClientConfig) {
  // We still instantiate Stripe so that constructWebhookEvent and other
  // read-only methods work, but write operations are stubbed.
  const stripe = new Stripe(config.secretKey, {
    apiVersion: config.apiVersion ?? "2025-02-24.acacia",
  });
  const logger = config.logger;

  function shadowLog(action: string, params: Record<string, unknown>) {
    const entry = { shadow: true, action, ...params };
    if (logger) {
      logger.info("SHADOW: would have " + action, entry);
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  return {
    stripe,

    async createCheckoutSession(
      payload: CheckoutSessionPayload,
    ): Promise<CheckoutSessionResult> {
      shadowLog("stripe.createCheckoutSession", {
        lineItems: payload.lineItems,
        customerEmail: payload.customerEmail,
        clientReferenceId: payload.clientReferenceId,
        metadata: payload.metadata,
      });
      return {
        id: "shadow-session-id",
        url: "https://shadow.example.com/checkout",
        status: "open",
      };
    },

    async getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
      return stripe.checkout.sessions.retrieve(sessionId);
    },

    async listLineItems(
      sessionId: string,
      params?: Stripe.Checkout.SessionListLineItemsParams,
    ): Promise<Stripe.ApiList<Stripe.LineItem>> {
      return stripe.checkout.sessions.listLineItems(sessionId, params);
    },

    constructWebhookEvent(
      payload: string | Buffer,
      signature: string,
      secret: string,
    ): Stripe.Event {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    },
  };
}

export function stripeClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof createStripeClient> {
  const key = resolveSecretKey(env);
  return createStripeClient({ secretKey: key });
}

function resolveSecretKey(env: NodeJS.ProcessEnv): string {
  if (env.STRIPE_SECRET_KEY) return env.STRIPE_SECRET_KEY;
  if (env.STRIPE_SECRET_KEY_PATH) {
    return readFileSync(env.STRIPE_SECRET_KEY_PATH, "utf-8").trim();
  }
  throw new Error(
    "Stripe secret key is required (STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_PATH)",
  );
}

export { Stripe };
