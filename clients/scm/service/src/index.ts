import { config } from "dotenv";
import { resolve } from "node:path";
import express from "express";
import { Pool } from "pg";
import { ConversationService, recoverUnsentReplies } from "./conversation-service.js";
import { createGhlClient } from "@romea/ghl-client";
import { createAcuityClient } from "@romea/acuity-client";
import { createStripeClient } from "@romea/stripe-client";
import { loadConfig } from "@romea/model-router";
import { createRouter } from "@romea/scm-flow";

/* Load .env from clients/scm/.env */
config({ path: resolve(process.cwd(), "clients/scm/.env") });

const PORT = Number(process.env.PORT ?? 3000);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
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

const ghl = createGhlClient({ token: process.env.GHL_PIT ?? "" });
const acuity = createAcuityClient({
  userId: process.env.ACUITY_USER_ID ?? "",
  apiKey: process.env.ACUITY_API_KEY ?? "",
  db,
});
const stripe = createStripeClient({
  secretKey: process.env.STRIPE_SECRET_KEY ?? "",
});

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
await recoverUnsentReplies(db, (locationId, contactId, payload) =>
  ghl.sendMessage(locationId, contactId, payload as { message: string; channel: "sms" | "live_chat" | "whatsapp" | "email" }),
);

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  const result = await service.health();
  res.status(result.ok ? 200 : 503).json(result);
});

app.post("/selfcaremen", async (req, res) => {
  const payload = req.body;
  if (
    !payload?.contact_id ||
    !payload?.location_id ||
    !payload?.message?.id
  ) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  try {
    const result = await service.handleInbound(payload);
    res.status(200).json(result);
  } catch (err) {
    console.error("[index] unhandled error:", err);
    res.status(500).json({ error: "internal_error" });
  }
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
