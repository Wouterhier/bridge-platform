import { config } from "dotenv";
import { resolve } from "node:path";
import express from "express";
import { Pool } from "pg";
import { createGhlClient } from "@romea/ghl-client";
import { createAcuityClient } from "@romea/acuity-client";
import { createStripeClient } from "@romea/stripe-client";
import { loadConfig } from "@romea/model-router";
import { createRouter } from "@romea/scm-flow";
import { PaymentService, WebhookError } from "./payment-service.js";

/* Load .env from clients/scm/.env */
config({ path: resolve(process.cwd(), "clients/scm/.env") });

const PORT = Number(process.env.PAYMENT_PORT ?? 3001);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30000);
const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID ?? "";
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = new Pool({ connectionString: DATABASE_URL });

const ghl = createGhlClient({ token: process.env.GHL_PIT ?? "" });
const acuity = createAcuityClient({
  userId: process.env.ACUITY_USER_ID ?? "",
  apiKey: process.env.ACUITY_API_KEY ?? "",
  db,
});
const stripe = createStripeClient({
  secretKey: process.env.STRIPE_SECRET_KEY ?? "",
});

const router = createRouter(
  loadConfig({ dotenvPaths: [resolve(process.cwd(), "clients/scm/.env")] }),
);

const service = new PaymentService({
  db,
  ghl,
  acuity,
  stripe,
  router,
  ghlPipelineId: GHL_PIPELINE_ID,
  ghlLocationId: GHL_LOCATION_ID,
  stripeWebhookSecret: STRIPE_WEBHOOK_SECRET,
  pollIntervalMs: POLL_INTERVAL_MS,
});

/* Start background poller for webhook-fallback idempotency */
service.startPoller();

const app = express();

app.get("/health", async (_req, res) => {
  const result = await service.health();
  res.status(result.ok ? 200 : 503).json(result);
});

/**
 * Stripe webhook endpoint.
 *
 * Uses express.raw() so the raw body is available for signature
 * verification.  This route must be registered BEFORE any global
 * express.json() middleware.
 */
app.post(
  "/webhooks/stripe/selfcaremen",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body as Buffer;
    const signature = req.headers["stripe-signature"] as string;

    if (!signature) {
      res.status(400).json({ error: "missing_signature" });
      return;
    }

    try {
      await service.handleWebhook(rawBody, signature);
      res.status(200).json({ received: true });
    } catch (err) {
      if (err instanceof WebhookError) {
        res.status(err.statusCode).json({ error: err.message });
      } else {
        console.error("[index] unhandled webhook error:", err);
        res.status(500).json({ error: "internal_error" });
      }
    }
  },
);

const server = app.listen(PORT, () => {
  console.log(`[selfcaremen-payment] listening on :${PORT}`);
});

/* Graceful shutdown */
function shutdown() {
  console.log("[selfcaremen-payment] shutting down...");
  service.stopPoller();
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
