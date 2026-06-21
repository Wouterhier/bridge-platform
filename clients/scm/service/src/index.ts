import { config } from "dotenv";
import { resolve } from "node:path";
import express from "express";
import { Pool } from "pg";
import { ConversationService, recoverUnsentReplies, parseInbound } from "./conversation-service.js";
import { createGhlClient, createShadowGhlClient } from "@romea/ghl-client";
import { createAcuityClient, createShadowAcuityClient } from "@romea/acuity-client";
import { createStripeClient, createShadowStripeClient } from "@romea/stripe-client";
import { loadConfig } from "@romea/model-router";
import { createRouter } from "@romea/scm-flow";

/* Load .env from clients/scm/.env */
config({ path: resolve(process.cwd(), "clients/scm/.env") });

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL =
  process.env.SHADOW_MODE === "true"
    ? (process.env.SHADOW_DATABASE_URL ?? process.env.DATABASE_URL ?? "")
    : (process.env.DATABASE_URL ?? "");
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS ?? 2000);
const HOLDING_THRESHOLD_MS = Number(
  process.env.HOLDING_THRESHOLD_MS ?? 3000,
);
const GHL_PIPELINE_ID = process.env.GHL_PIPELINE_ID ?? "";
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL ?? "";
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL ?? "";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = new Pool({ connectionString: DATABASE_URL });

const isShadow = process.env.SHADOW_MODE === "true";
if (isShadow) {
  console.log("[selfcaremen-conversation] Starting in SHADOW MODE - all writes suppressed");
} else {
  console.log("[selfcaremen-conversation] Starting in LIVE MODE - real GHL/Acuity/Stripe clients active");
}

const ghl = isShadow
  ? createShadowGhlClient({ token: process.env.GHL_PIT ?? "" })
  : createGhlClient({ token: process.env.GHL_PIT ?? "" });
const acuity = isShadow
  ? createShadowAcuityClient({
      userId: process.env.ACUITY_USER_ID ?? "",
      apiKey: process.env.ACUITY_API_KEY ?? "",
      db,
    })
  : createAcuityClient({
      userId: process.env.ACUITY_USER_ID ?? "",
      apiKey: process.env.ACUITY_API_KEY ?? "",
      db,
    });
const stripe = isShadow
  ? createShadowStripeClient({ secretKey: process.env.STRIPE_SECRET_KEY ?? "" })
  : createStripeClient({ secretKey: process.env.STRIPE_SECRET_KEY ?? "" });

const router = createRouter(loadConfig({ dotenvPaths: [resolve(process.cwd(), "clients/scm/.env")] }));

const service = new ConversationService({
  db,
  ghl,
  acuity,
  stripe,
  router,
  debounceMs: DEBOUNCE_MS,
  holdingThresholdMs: HOLDING_THRESHOLD_MS,
  ghlPipelineId: GHL_PIPELINE_ID,
  stripeSuccessUrl: STRIPE_SUCCESS_URL,
  stripeCancelUrl: STRIPE_CANCEL_URL,
});

/* Recover any unsent replies from previous crash before accepting traffic */
await recoverUnsentReplies(
  db,
  (locationId, contactId, payload) =>
    ghl.sendMessage(locationId, contactId, payload),
  (rawPayload) => service.handleInbound(rawPayload),  // re-process state-A rows
);

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  const result = await service.health();
  res.status(result.ok ? 200 : 503).json(result);
});

app.post("/selfcaremen", async (req, res) => {
  const rawPayload = req.body;
  const parsed = parseInbound(rawPayload);

  if (!parsed) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const messageId = parsed.message.id;
  if (!messageId) {
    return res.status(400).json({ error: "missing message id" });
  }

  /* 1. Check dedup BEFORE ack */
  const alreadyProcessed = await db.query(
    "SELECT sent_at FROM processed_messages WHERE message_id = $1",
    [messageId],
  );
  if (alreadyProcessed.rows.length > 0) {
    return res.status(200).json({ status: "duplicate" });
  }

  /* 2. Persist to processed_messages BEFORE 202 ack */
  await db.query(
    `INSERT INTO processed_messages (message_id, contact_id, send_attempts, raw_inbound)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT DO NOTHING`,
    [messageId, parsed.contact_id, JSON.stringify(rawPayload)],
  );

  /* 3. 202 immediately */
  res.status(202).json({ status: "accepted" });

  /* 4. Process async in background — crash here is recovered by startup recoverUnsentReplies() */
  service.handleInbound(rawPayload).catch((err) => {
    process.stderr.write("[index] background processing failed: " + JSON.stringify({ messageId, err }) + "\n");
  });
});

const server = app.listen(PORT, () => {
  console.log(`[selfcaremen-conversation] listening on :${PORT}`);
});

/* Graceful shutdown */
function shutdown() {
  console.log("[selfcaremen-conversation] shutting down...");
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
