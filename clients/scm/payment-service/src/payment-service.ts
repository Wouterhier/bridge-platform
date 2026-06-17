import type { Pool } from "pg";
import type { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import type { ModelRouter } from "@romea/model-router";
import { onPaymentConfirmed } from "./payment-processor.js";
import Stripe from "stripe";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PaymentServiceConfig {
  db: Pool;
  ghl: ReturnType<typeof createGhlClient>;
  acuity: ReturnType<typeof createAcuityClient>;
  stripe: ReturnType<typeof createStripeClient>;
  router: ModelRouter;
  ghlPipelineId: string;
  ghlLocationId: string;
  stripeWebhookSecret: string;
  pollIntervalMs: number;
}

/* ------------------------------------------------------------------ */
/*  Payment Service                                                    */
/* ------------------------------------------------------------------ */

export class PaymentService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private deps: PaymentServiceConfig) {}

  async health(): Promise<{ ok: boolean; db: boolean }> {
    try {
      await this.deps.db.query("SELECT 1");
      return { ok: true, db: true };
    } catch {
      return { ok: false, db: false };
    }
  }

  /**
   * Handle a Stripe webhook POST.
   *
   * 1. Read raw body and Stripe-Signature header.
   * 2. Call stripeClient.constructWebhookEvent(rawBody, signature, secret).
   * 3. If signature invalid, throw WebhookError(400).
   * 4. On checkout.session.completed, call onPaymentConfirmed.
   */
  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const { stripe, stripeWebhookSecret } = this.deps;

    if (!signature) {
      throw new WebhookError("missing_signature", 400);
    }

    let event: Stripe.Event;
    try {
      event = stripe.constructWebhookEvent(
        rawBody,
        signature,
        stripeWebhookSecret,
      );
    } catch (err) {
      console.error("[payment-service] webhook signature invalid:", err);
      throw new WebhookError("invalid_signature", 400);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      await onPaymentConfirmed(session, {
        db: this.deps.db,
        ghl: this.deps.ghl,
        acuity: this.deps.acuity,
        stripe: this.deps.stripe,
        router: this.deps.router,
        ghlPipelineId: this.deps.ghlPipelineId,
        ghlLocationId: this.deps.ghlLocationId,
      });
    }
  }

  /** Start the background poller for pending payments. */
  startPoller(): void {
    if (this.pollTimer) return;
    const interval = this.deps.pollIntervalMs;
    this.pollTimer = setInterval(() => this.pollPendingPayments(), interval);
    console.log(`[payment-service] poller started (${interval}ms)`);
  }

  /** Stop the background poller. */
  stopPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log("[payment-service] poller stopped");
    }
  }

  /**
   * Poll pending payment sessions and converge any that have been paid.
   * This is public so tests can invoke it directly; in production it is
   * driven by startPoller().
   */
  async pollPendingPayments(): Promise<void> {
    try {
      const result = await this.deps.db.query<{
        stripe_session_id: string;
      }>(
        `SELECT stripe_session_id FROM payment_sessions
         WHERE status = 'pending'
           AND created_at > now() - interval '2 hours'`,
      );

      for (const row of result.rows) {
        try {
          const session = await this.deps.stripe.getCheckoutSession(
            row.stripe_session_id,
          );
          if (session.payment_status === "paid") {
            await onPaymentConfirmed(session, {
              db: this.deps.db,
              ghl: this.deps.ghl,
              acuity: this.deps.acuity,
              stripe: this.deps.stripe,
              router: this.deps.router,
              ghlPipelineId: this.deps.ghlPipelineId,
              ghlLocationId: this.deps.ghlLocationId,
            });
          }
        } catch (err) {
          console.error(
            `[payment-service] poll failed for ${row.stripe_session_id}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error("[payment-service] poll query failed:", err);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WebhookError";
  }
}
