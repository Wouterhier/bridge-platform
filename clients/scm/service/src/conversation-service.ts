import { Pool } from "pg";
import type { ModelRouter } from "@romea/model-router";
import { createEngine } from "@romea/state-machine";
import {
  createScmStateMachineConfig,
  type ScmState,
  type ScmCollected,
  type ScmContext,
  type SlotMenuItem,
} from "@romea/scm-flow";
import { extract, type ExtractionHint } from "@romea/scm-flow";
import { generate } from "@romea/scm-flow";
import { getFallbackMessage } from "@romea/scm-flow";
import { shouldEscalate } from "@romea/scm-flow";
import { getService, isPaidService } from "@romea/scm-flow";
import { validatePhone, validateEmail } from "@romea/scm-flow";
import { gateApiCall } from "@romea/scm-flow";
import { sanitizeOutput } from "@romea/scm-flow";
import type { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import { mapIntakeFields } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import {

  markMessageProcessed,
  markMessageSent,
  incrementSendAttempts,
  recoverUnsentReplies,
} from "@romea/bridge-db";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface InboundMessage {
  id: string;
  body: string;
  direction: string;
  type: string;
}

export interface InboundPayload {
  contact_id: string;
  location_id: string;
  conversation_id?: string;
  message: InboundMessage;
}

/**
 * Parse a raw GHL inbound webhook payload into the normalized InboundPayload.
 * Handles both the native InboundMessage API shape and the flat workflow-webhook shape.
 */
export function parseInbound(raw: unknown): InboundPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;

  /* ── contactId ── */
  const contactId =
    (payload.contact_id as string) ||
    (payload.contactId as string) ||
    (payload.contact as Record<string, string> | undefined)?.id;
  if (!contactId) return null;

  /* ── locationId ── */
  const locationId =
    (payload.location_id as string) ||
    (payload.locationId as string) ||
    (payload.location as Record<string, string> | undefined)?.id;
  if (!locationId) return null;

  /* ── conversationId ── */
  const conversationId =
    (payload.conversationId as string) ||
    (payload.conversation_id as string) ||
    (payload.message as Record<string, unknown> | undefined)?.conversationId as string | undefined;

  /* ── message ── */
  const msgRaw = payload.message;
  let messageBody = "";
  let messageId = "";
  let messageType = "";
  let messageDirection = "inbound";

  if (typeof msgRaw === "string") {
    messageBody = msgRaw;
  } else if (msgRaw && typeof msgRaw === "object") {
    const msgObj = msgRaw as Record<string, unknown>;
    messageBody = (msgObj.body as string) || (msgObj.text as string) || "";
    messageId = (msgObj.id as string) || "";
    messageType = normalizeMessageType(msgObj.type);
    messageDirection = (msgObj.direction as string) || "inbound";
  }

  /* Top-level fallbacks when message wrapper is absent */
  if (!messageBody) {
    messageBody = (payload.body as string) || (payload.text as string) || "";
  }
  if (!messageId) {
    messageId = (payload.messageId as string) || (payload.message_id as string) || "";
  }

  /* GHL workflow webhooks send no message id. Synthesize a stable per-message
     key from contact + body + 10s time bucket so identical rapid repeats dedupe
     but a later identical message is allowed. */
  if (!messageId) {
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const bucket = Math.floor(Date.now() / 10000);
    messageId = "syn-" + crypto
      .createHash("sha256")
      .update(`${contactId}|${messageBody}|${bucket}`)
      .digest("hex")
      .slice(0, 32);
  }
  if (!messageType) {
    messageType = normalizeMessageType(
      payload.type ?? payload.messageType ?? payload.message_type,
    );
  }

  return {
    contact_id: contactId,
    location_id: locationId,
    conversation_id: conversationId,
    message: {
      id: messageId,
      body: messageBody,
      direction: messageDirection,
      type: messageType,
    },
  };
}

export interface HandlerResult {
  sent: boolean;
  reply?: string;
  reason?: string;
}

export interface ConversationServiceConfig {
  db: Pool;
  ghl: ReturnType<typeof createGhlClient>;
  acuity: ReturnType<typeof createAcuityClient>;
  stripe: ReturnType<typeof createStripeClient>;
  router: ModelRouter;
  debounceMs: number;
  holdingThresholdMs: number;
  ghlPipelineId: string;
  stripeSuccessUrl: string;
  stripeCancelUrl: string;
}

interface ConversationRow {
  id: string;
  contact_id: string;
  location_id: string;
  ghl_conversation_id: string | null;
  current_state: string;
  collected_fields: Record<string, unknown>;
  context: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/* Allow extra runtime fields on collected */
type CollectedWithExtras = ScmCollected & Record<string, unknown>;

/* ── Slot formatting ──────────────────────────────────────────────────── */
const NZ_TIMEZONE = "Pacific/Auckland";

function formatSlotForDisplay(isoString: string, timezone: string): string {
  const d = new Date(isoString);
  return (
    new Intl.DateTimeFormat("en-NZ", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    }).format(d) +
    " " +
    timezone
  );
}

/* ------------------------------------------------------------------ */
/*  Holding-message templates                                          */
/* ------------------------------------------------------------------ */

const holdingTemplates = [
  "Just a moment while I check availability for you.",
  "One moment please - I am pulling up the latest slots.",
  "Give me a second to confirm that with the calendar.",
];

function pickHoldingTemplate(): string {
  const idx = Math.floor(Math.random() * holdingTemplates.length);
  return holdingTemplates[idx];
}

/* ------------------------------------------------------------------ */
/*  Stage mapping                                                      */
/* ------------------------------------------------------------------ */

const STAGE_NEW_LEAD = "26763fc3-9013-42f6-a3cd-b254bf61f467";
const STAGE_AI_REPLIED = "6459bbb1-4517-4383-b4cb-dffe867f4c54";
const STAGE_ELIGIBILITY_BOOKED = "b000d5c7-de71-4997-b263-74162c416736";
const STAGE_PAID_BOOKED = "750a6c84-d60f-424a-ac88-876d06fa362d";
const STAGE_HUMAN_TOUCH = "d1cb71e3-4e11-4b7b-bffc-a6c574a9c5f4";

function stageIdForState(
  state: ScmState,
  serviceKey?: string,
): string | undefined {
  switch (state) {
    case "NEW":
      return STAGE_NEW_LEAD;
    case "ENGAGING":
    case "COLLECTING":
    case "SELECTING_SERVICE":
    case "SHOWING_SLOTS":
    case "AWAITING_SELECTION":
    case "CREATING_CHECKOUT":
    case "AWAITING_PAYMENT":
      return STAGE_AI_REPLIED;
    case "BOOKING_ACUITY":
      return STAGE_ELIGIBILITY_BOOKED;
    case "CONFIRMED":
      if (serviceKey && !isPaidService(serviceKey)) {
        return STAGE_ELIGIBILITY_BOOKED;
      }
      return STAGE_PAID_BOOKED;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/*  DB helpers                                                         */
/* ------------------------------------------------------------------ */

async function isMessageProcessed(db: Pool, messageId: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM processed_messages WHERE message_id = $1 AND send_payload IS NOT NULL)`,
    [messageId],
  );
  return result.rows[0]?.exists ?? false;
}

async function shouldDebounce(
  db: Pool,
  contactId: string,
  debounceMs: number,
): Promise<boolean> {
  const result = await db.query<{ processed_at: Date }>(
    `SELECT processed_at FROM processed_messages
     WHERE contact_id = $1 AND send_payload IS NOT NULL
     ORDER BY processed_at DESC
     LIMIT 1`,
    [contactId],
  );
  if (result.rows.length === 0) return false;
  const lastProcessed = new Date(result.rows[0].processed_at).getTime();
  return Date.now() - lastProcessed < debounceMs;
}

/* ------------------------------------------------------------------ */
/*  Webhook seeding                                                    */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_NAMES = new Set(["guest visitor", "guest", "visitor", "test user", "test", "user"]);

function seedFromWebhook(raw: Record<string, unknown>): Partial<ScmCollected> {
  const seeded: Partial<ScmCollected> = {};

  // Name extraction
  const fullName =
    (raw.full_name as string) ||
    (raw.fullName as string) ||
    (raw.name as string) ||
    ((raw.first_name as string) && (raw.last_name as string)
      ? `${raw.first_name as string} ${raw.last_name as string}`.trim()
      : undefined) ||
    ((raw.firstName as string) && (raw.lastName as string)
      ? `${raw.firstName as string} ${raw.lastName as string}`.trim()
      : undefined);

  if (fullName && !PLACEHOLDER_NAMES.has(fullName.toLowerCase().trim())) {
    seeded.fullName = fullName.trim();
  }

  // Phone extraction + normalization
  const rawPhone = (raw.phone as string) || (raw.phoneNumber as string) || (raw.mobile as string);
  if (rawPhone) {
    const phoneResult = validatePhone(rawPhone);
    if (phoneResult.ok && phoneResult.value) {
      seeded.phone = phoneResult.value;
    }
  }

  // Email extraction + validation
  const rawEmail = (raw.email as string) || (raw.emailAddress as string);
  if (rawEmail) {
    const emailResult = validateEmail(rawEmail);
    if (emailResult.ok && emailResult.value) {
      seeded.email = emailResult.value;
    }
  }

  return seeded;
}

async function findOrCreateConversation(
  db: Pool,
  locationId: string,
  contactId: string,
  ghlConversationId?: string,
  webhookPayload?: Record<string, unknown>,
): Promise<ConversationRow> {
  const existing = await db.query<ConversationRow>(
    `SELECT * FROM conversations WHERE location_id = $1 AND contact_id = $2 LIMIT 1`,
    [locationId, contactId],
  );
  if (existing.rows.length > 0) {
    // Always update ghl_conversation_id if provided (GHL may rotate it)
    if (ghlConversationId) {
      await db.query(
        `UPDATE conversations SET ghl_conversation_id = $1, updated_at = now() WHERE id = $2`,
        [ghlConversationId, existing.rows[0].id],
      );
      return { ...existing.rows[0], ghl_conversation_id: ghlConversationId };
    }

    // Merge webhook seeds for existing conversation (only fill gaps)
    if (webhookPayload) {
      const seeded = seedFromWebhook(webhookPayload);
      const current = existing.rows[0].collected_fields as Record<string, unknown>;
      const merged = { ...current };
      let hasNew = false;
      for (const [key, value] of Object.entries(seeded)) {
        if (merged[key] === undefined || merged[key] === null || merged[key] === "") {
          merged[key] = value;
          hasNew = true;
        }
      }
      if (hasNew) {
        await db.query(
          `UPDATE conversations SET collected_fields = $1, updated_at = now() WHERE id = $2`,
          [JSON.stringify(merged), existing.rows[0].id],
        );
        return { ...existing.rows[0], collected_fields: merged };
      }
    }

    return existing.rows[0];
  }

  // New conversation: seed from webhook if available
  const seeded = webhookPayload ? seedFromWebhook(webhookPayload) : {};
  const inserted = await db.query<ConversationRow>(
    `INSERT INTO conversations (location_id, contact_id, ghl_conversation_id, current_state, collected_fields, context)
     VALUES ($1, $2, $3, 'NEW', $4, '{}')
     RETURNING *`,
    [locationId, contactId, ghlConversationId ?? null, JSON.stringify(seeded)],
  );
  return inserted.rows[0];
}

async function updateConversation(
  db: Pool,
  conversationId: string,
  state: ScmState,
  collected: ScmCollected,
  context: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `UPDATE conversations
     SET current_state = $1,
         collected_fields = $2,
         context = $3,
         updated_at = now()
     WHERE id = $4`,
    [state, JSON.stringify(collected), JSON.stringify(context), conversationId],
  );
}

/* ------------------------------------------------------------------ */
/*  Channel mapping                                                    */
/* ------------------------------------------------------------------ */

function mapMessageTypeToChannel(type: string): "sms" | "live_chat" | "whatsapp" | "email" {
  const lower = type.toLowerCase();
  // Handle both GHL prefixed types (TYPE_SMS, TYPE_LIVE_CHAT) and plain types
  const normalized = lower.replace(/^type_/, "");
  if (normalized === "sms") return "sms";
  if (normalized === "live_chat" || normalized === "livechat") return "live_chat";
  if (normalized === "whatsapp") return "whatsapp";
  if (normalized === "email") return "email";
  return "sms";
}

/* ------------------------------------------------------------------ */
/*  Channel-aware send payload builder (ONE source of truth)           */
/* ------------------------------------------------------------------ */

function buildGhlSendPayload(
  channel: "sms" | "live_chat" | "whatsapp" | "email",
  contactId: string,
  _conversationId: string | undefined,
  message: string,
): import("@romea/ghl-client").GhlMessagePayload {
  const typeMap = { sms: "SMS", live_chat: "Live_Chat", whatsapp: "WhatsApp", email: "Email" } as const;
  return { type: typeMap[channel] ?? "SMS", contactId, message };
}

/* ------------------------------------------------------------------ */
/*  Extraction helper                                                  */
/* ------------------------------------------------------------------ */

interface ExtractResult {
  value: string | null;
  safetyConcern: boolean;
  concernType?: string;
  fields?: Partial<ScmCollected>;
}

async function tryExtract(
  state: ScmState,
  rawMessage: string,
  collected: ScmCollected,
  router: ModelRouter,
): Promise<ExtractResult> {
  const hint = await extract(state, rawMessage, [], collected, { router });
  if (!hint) return { value: null, safetyConcern: false };

  const safetyConcern = hint.safety_concern === true;
  const concernType = hint.concern_type as string | undefined;

  switch (state) {
    case "ENGAGING":
    case "COLLECTING": {
      const fields: Partial<ScmCollected> = {};
      if (hint.fullName) {
        fields.fullName = hint.fullName;
      } else if (hint.firstName && hint.lastName) {
        fields.fullName = `${hint.firstName} ${hint.lastName}`;
      }
      if (hint.phone) fields.phone = hint.phone;
      if (hint.email) fields.email = hint.email;
      if (hint.dob) fields.dobRaw = hint.dob;
      if (hint.serviceKey) fields.serviceKey = hint.serviceKey;
      if (hint.bookingIntent) fields.bookingIntent = true;
      return { value: null, safetyConcern, concernType, fields };
    }
    case "SELECTING_SERVICE":
      if (hint.serviceKey) return { value: hint.serviceKey, safetyConcern, concernType };
      return { value: null, safetyConcern, concernType };
    case "AWAITING_SELECTION":
      if (hint.slotIso) return { value: hint.slotIso, safetyConcern, concernType };
      return { value: null, safetyConcern, concernType };
    default:
      return { value: null, safetyConcern, concernType };
  }
}

/* re-export for backward compat — moved to @romea/bridge-db */
export { recoverUnsentReplies } from "@romea/bridge-db";

/* GHL / LeadConnector standard message type IDs (numeric).
   Source: working n8n Inbound-message-type-mapper + GHL docs. */
const GHL_MESSAGE_TYPE_MAP: Record<number, string> = {
  1: "Email", 2: "SMS", 3: "GMB", 11: "FB", 12: "Call",
  18: "IG", 19: "WhatsApp", 29: "Live_Chat",
};

function normalizeMessageType(rawType: unknown): string {
  if (typeof rawType === "number") return GHL_MESSAGE_TYPE_MAP[rawType] ?? "SMS";
  const s = String(rawType ?? "").trim();
  if (/^\d+$/.test(s)) return GHL_MESSAGE_TYPE_MAP[parseInt(s, 10)] ?? "SMS";
  return s;
}


/* ------------------------------------------------------------------ */
/*  URL sanitisation                                                   */
/* ------------------------------------------------------------------ */

const stripeUrlPattern = /https?:\/\/[^\s]*stripe\.com\/[^\s]*/gi;

function stripPaymentUrls(text: string): string {
  return text.replace(stripeUrlPattern, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* ------------------------------------------------------------------ */
/*  Inbound message classification                                     */
/* ------------------------------------------------------------------ */

export type InboundClassification = 'text' | 'image' | 'system' | 'malformed';

export function classifyInbound(message: InboundMessage): InboundClassification {
  if (!message) return 'malformed';
  const type = (message.type || '').toLowerCase();
  if (!message.body || message.body.trim() === '') {
    if (type.includes('image') || type.includes('attachment') || type.includes('file')) return 'image';
    if (type.includes('sms') || type.includes('email') || type.includes('live_chat') || type.includes('whatsapp')) return 'system';
    return 'malformed';
  }
  return 'text';
}

/* ------------------------------------------------------------------ */
/*  Conversation Service                                               */
/* ------------------------------------------------------------------ */

export class ConversationService {
  private engine = createEngine(createScmStateMachineConfig());

  constructor(private deps: ConversationServiceConfig) {}

  async health(): Promise<{ ok: boolean; db: boolean }> {
    try {
      await this.deps.db.query("SELECT 1");
      return { ok: true, db: true };
    } catch {
      return { ok: false, db: false };
    }
  }

  async handleInbound(rawPayload: unknown): Promise<HandlerResult> {
    const payload = parseInbound(rawPayload);
    if (!payload) {
      return { sent: false, reason: "invalid_payload" };
    }

    const { db, ghl, acuity, stripe, router, debounceMs, holdingThresholdMs } =
      this.deps;
    const { contact_id, location_id, message } = payload;
    const messageId = message.id;

    /* 0. Classify inbound message */
    const classification = classifyInbound(message);
    if (classification === 'system' || classification === 'malformed') {
      return { sent: false, reason: `ignored:${classification}` };
    }
    if (classification === 'image') {
      const imgChannel = mapMessageTypeToChannel(message.type);
      await ghl.sendMessage(location_id, contact_id,
        buildGhlSendPayload(imgChannel, contact_id, payload.conversation_id,
          "I can't view images or attachments in this chat. A member of our team will review it and follow up shortly.")
      );
      const conversation = await findOrCreateConversation(db, location_id, contact_id, payload.conversation_id, rawPayload as Record<string, unknown>);
      await updateConversation(db, conversation.id, conversation.current_state as ScmState, conversation.collected_fields as ScmCollected, {
        ...conversation.context,
        escalated: true,
        escalationReason: 'image_attachment',
      });
      await this.updateStage(location_id, contact_id, conversation.current_state as ScmState, conversation.collected_fields as ScmCollected, true);
      return { sent: true, reason: 'escalated:image_attachment' };
    }

    const rawMessage = message.body;

    /* 1. Dedup */
    const alreadyProcessed = await isMessageProcessed(db, messageId);
    if (alreadyProcessed) {
      return { sent: false, reason: "dedup" };
    }

    /* 2. Debounce */
    const debounced = await shouldDebounce(db, contact_id, debounceMs);
    if (debounced) {
      return { sent: false, reason: "debounce" };
    }

    /* 3. Load / create conversation */
    let conversation = await findOrCreateConversation(db, location_id, contact_id, payload.conversation_id, rawPayload as Record<string, unknown>);

    /* 4. Escalation guard */
    const escalation = shouldEscalate(
      rawMessage,
      (conversation.collected_fields.serviceKey as string | undefined) ?? "",
    );
    if (escalation.escalate) {
      await this.escalate(location_id, contact_id, conversation, escalation.reason ?? "");
      return { sent: false, reason: `escalated:${escalation.reason ?? ""}` };
    }

    /* 5. Extract if needed */
    const currentState = conversation.current_state as ScmState;
    const extracted = await tryExtract(
      currentState,
      rawMessage,
      conversation.collected_fields as ScmCollected,
      router,
    );

    /* 5b. Model-side safety classification (layer 2) */
    if (extracted.safetyConcern) {
      await this.escalate(location_id, contact_id, conversation, `model_safety:${extracted.concernType ?? "concern"}`);
      return { sent: false, reason: "escalated:model_safety" };
    }

    /* 5c. Merge multi-field extraction for ENGAGING / COLLECTING */
    let preCollected: ScmCollected = { ...conversation.collected_fields };
    if (extracted.fields) {
      preCollected = { ...preCollected, ...extracted.fields };
    }
    // If a dobRaw was extracted, attempt normalization
    if (preCollected.dobRaw && !preCollected.dob) {
      const { normalizeDob } = await import("@romea/scm-flow");
      const dobResult = normalizeDob(preCollected.dobRaw);
      if (dobResult.ok) {
        preCollected = { ...preCollected, dob: dobResult.value };
      }
    }

    // Update missingFields for COLLECTING state
    if (currentState === "COLLECTING" || currentState === "SELECTING_SERVICE") {
      const { getService } = await import("@romea/scm-flow");
      const cfg =
        typeof preCollected.serviceKey === "string"
          ? getService(preCollected.serviceKey)
          : (preCollected.serviceKey as { acuityTypeId?: number } | undefined);
      if (cfg?.acuityTypeId) {
        const { gateApiCall } = await import("@romea/scm-flow");
        const gate = gateApiCall(cfg.acuityTypeId, preCollected as Record<string, unknown>);
        if (!gate.ready) {
          preCollected = { ...preCollected, missingFields: gate.missing.map((f) => f.key) };
        } else {
          preCollected = { ...preCollected, missingFields: [] };
        }
      }
    }

    const enrichedRawMessage = extracted.value ?? rawMessage;

    /* 6. Run state machine */
    const context: ScmContext =
      (conversation.context as ScmContext) ?? {};
    const smStart = Date.now();
    const transition = await this.engine.process({
      rawMessage: enrichedRawMessage,
      conversation: {
        currentState,
        collected: preCollected as Record<string, unknown>,
      },
      context,
    });
    const smDuration = Date.now() - smStart;

    let nextState = transition.state;
    let collected = transition.collected as CollectedWithExtras;

    /* Structured log for every state transition */
    const transitionedField =
      collected.fullName !== conversation.collected_fields.fullName ? "fullName"
      : collected.phone !== conversation.collected_fields.phone ? "phone"
      : collected.email !== conversation.collected_fields.email ? "email"
      : collected.dob !== conversation.collected_fields.dob ? "dob"
      : collected.serviceKey !== conversation.collected_fields.serviceKey ? "serviceKey"
      : collected.slotIso !== conversation.collected_fields.slotIso ? "slotIso"
      : collected.bookingIntent !== conversation.collected_fields.bookingIntent ? "bookingIntent"
      : "none";
    process.stdout.write(JSON.stringify({
      action: "state.transition",
      contactId: contact_id,
      fromState: currentState,
      toState: nextState,
      field: transitionedField,
      durationMs: smDuration,
    }) + "\n");

    /* 6b. Store formatted slot when patient selected one */
    if (
      currentState === "AWAITING_SELECTION" &&
      collected.slotIso &&
      Array.isArray(collected.slotMenu)
    ) {
      const selected = (collected.slotMenu as SlotMenuItem[]).find(
        (s) => s.iso === collected.slotIso,
      );
      if (selected?.formatted) {
        collected = { ...collected, slotFormatted: selected.formatted };
      }
    }

    
    /* 6c. Upsert collected contact fields to GHL (name/phone/email).
       GHL creates a "Guest Visitor" placeholder; once we have real values,
       write them back so the CRM contact is correct. Best-effort, non-fatal. */
    try {
      const contactPatch: Record<string, string> = {};
      if (typeof collected.fullName === "string" && collected.fullName.trim()) {
        const parts = collected.fullName.trim().split(/\s+/);
        contactPatch.firstName = parts[0];
        if (parts.length > 1) contactPatch.lastName = parts.slice(1).join(" ");
      }
      if (typeof collected.phone === "string" && collected.phone) contactPatch.phone = collected.phone;
      if (typeof collected.email === "string" && collected.email) contactPatch.email = collected.email;
      if (Object.keys(contactPatch).length > 0) {
        await ghl.updateContact(location_id, contact_id, contactPatch);
      }
    } catch (err) {
      process.stderr.write("[conversation-service] contact upsert failed: " + String(err) + "\n");
    }

    /* 7. Handle special states (with holding-message support) */
    if (nextState === "SHOWING_SLOTS") {
      const slotsResult = await this.handleShowingSlots(
        acuity,
        collected,
        conversation,
        holdingThresholdMs,
        location_id,
        contact_id,
      );
      nextState = slotsResult.state;
      collected = slotsResult.collected;
    }

    if (nextState === "CREATING_CHECKOUT") {
      const checkoutResult = await this.handleCreatingCheckout(
        stripe,
        db,
        collected,
        conversation,
        holdingThresholdMs,
        location_id,
        contact_id,
      );
      nextState = checkoutResult.state;
      collected = checkoutResult.collected;
    }

    if (nextState === "BOOKING_ACUITY") {
      const bookingResult = await this.handleBookingAcuity(
        acuity,
        db,
        collected,
        conversation,
        location_id,
        contact_id,
      );
      nextState = bookingResult.state;
      collected = bookingResult.collected;
    }

    /* 8. Generate reply
       NOTE: sanitizeOutput() is called INSIDE generate() (via callGenerate)
       for all model-produced text. It is NOT called on:
       - fallback messages from getFallbackMessage() (hardcoded, no em dashes)
       - holding messages (now sanitized explicitly before send)
       - image-attachment response or escalation notice (hardcoded)
       The payment-link append happens AFTER sanitization. */
    let replyText: string;
    try {
      replyText = await generate(
        nextState,
        collected as ScmCollected,
        [],
        undefined,
        transition.validationError,
        { router },
      );
    } catch {
      replyText = getFallbackMessage(nextState);
    }

    /* Append slot menu when in AWAITING_SELECTION — code-built, model-agnostic */
    if (nextState === "AWAITING_SELECTION") {
      const slotMenu = collected.slotMenuFormatted as string | undefined;
      if (slotMenu) {
        replyText = `${replyText}\n\n${slotMenu}`;
      }
    }

    /* Append payment link when relevant — strip any model-hallucinated URLs first */
    if (nextState === "AWAITING_PAYMENT" || nextState === "CREATING_CHECKOUT") {
      const paymentLink = collected._paymentLink as string | undefined;
      if (paymentLink) {
        replyText = `${stripPaymentUrls(replyText)}\n\n${paymentLink}`;
      }
    }

    /* Append booking summary for CONFIRMED / BOOKING_ACUITY so model can never omit facts */
    if (nextState === "CONFIRMED" || nextState === "BOOKING_ACUITY") {
      const svc = getService(collected.serviceKey as string);
      if (svc && collected.slotFormatted) {
        const bookingSummary = [
          "",
          "--- Your booking ---",
          `Service: ${svc.name}`,
          `Date: ${collected.slotFormatted}`,
          `Duration: ${svc.duration} min`,
          `Price: ${svc.price === 0 ? "Free" : `NZD $${svc.price}`}`,
          "---",
        ].join("\n");
        replyText = replyText + bookingSummary;
      }
    }

    /* 9. Record processed_messages BEFORE sending reply.
          sent_at is left NULL until the send succeeds so that
          recoverUnsentReplies() can find and re-deliver on restart.
          Store the FULL SendPayload (GhlMessagePayload + locationId) so recovery has everything it needs. */
    const channel = mapMessageTypeToChannel(message.type);
    let convId = payload.conversation_id ?? (conversation.ghl_conversation_id as string | undefined) ?? undefined;
    if (channel === "live_chat" && !convId) {
      try {
        convId = await ghl.getConversationId(location_id, contact_id);
        if (convId) {
          await db.query(
            `UPDATE conversations SET ghl_conversation_id = $1 WHERE id = $2`,
            [convId, conversation.id],
          );
        }
      } catch (err) {
        process.stderr.write("[conversation-service] getConversationId failed: " + String(err) + "\n");
      }
    }
    const ghlPayload = buildGhlSendPayload(channel, contact_id, convId, replyText);
    const sendPayload: import("@romea/bridge-db").SendPayload = {
      ...ghlPayload,
      locationId: location_id,
    };
    await markMessageProcessed(db, messageId, contact_id, sendPayload);

    /* 10. Send reply */
    try {
      await ghl.sendMessage(location_id, contact_id, sendPayload);
      /* Mark as sent on success */
      await markMessageSent(db, messageId);
    } catch (err) {
      /* Leave sent_at NULL so recovery will retry.
         Increment attempts so we can eventually give up. */
      await incrementSendAttempts(db, messageId);
      process.stderr.write("[conversation-service] GHL send failed: " + String(err) + " BODY: " + JSON.stringify((err as any).data) + " PAYLOAD: " + JSON.stringify(sendPayload) + "\n");
    }

    /* 11. Update conversation state in Postgres */
    const updatedContext: Record<string, unknown> = {
      ...conversation.context,
      lastInboundMessageId: messageId,
      holdingMessageSent: false, /* reset for next exchange */
    };
    await updateConversation(db, conversation.id, nextState, collected as ScmCollected, updatedContext);

    /* 12. Update GHL opportunity stage */
    await this.updateStage(location_id, contact_id, nextState, collected as ScmCollected);

    return { sent: true, reply: replyText };
  }

  /* ---------------------------------------------------------------- */
  /*  SHOWING_SLOTS → fetch Acuity slots                               */
  /* ---------------------------------------------------------------- */
  private async handleShowingSlots(
    acuity: ReturnType<typeof createAcuityClient>,
    collected: CollectedWithExtras,
    conversation: ConversationRow,
    holdingThresholdMs: number,
    locationId: string,
    contactId: string,
  ): Promise<{ state: ScmState; collected: CollectedWithExtras }> {
    const service =
      typeof collected.serviceKey === "string"
        ? getService(collected.serviceKey)
        : (collected.serviceKey as { acuityTypeId?: number; calendarId?: string | number } | undefined);

    if (!service?.acuityTypeId) {
      return { state: "AWAITING_SELECTION", collected };
    }

    const svc = service as { acuityTypeId: number; calendarId: string | number };

    async function fetchSlots(): Promise<ReturnType<typeof acuity.getAvailability>> {
      const base = new Date();
      for (let i = 1; i <= 14; i++) {
        const d = new Date(base);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().split("T")[0];
        const slots = await acuity.getAvailability(svc.acuityTypeId, {
          calendarID: svc.calendarId,
          date: dateStr,
        });
        if (slots.length > 0) return slots;
      }
      return [];
    }

    const fetchPromise = fetchSlots();

    const alreadySent =
      (conversation.context as Record<string, unknown>)?.holdingMessageSent ===
      true;

    if (!alreadySent) {
      const timer = setTimeout(async () => {
        try {
          await this.deps.ghl.sendMessage(locationId, contactId,
            buildGhlSendPayload("sms", contactId, conversation.ghl_conversation_id ?? undefined,
              sanitizeOutput(pickHoldingTemplate()))
          );
        } catch (e) {
          process.stderr.write("[conversation-service] holding message failed: " + String(e) + "\n");
        }
      }, holdingThresholdMs);

      try {
        const slots = await fetchPromise;
        clearTimeout(timer);
        const slotMenu = (slots ?? []).slice(0, 5).map((s) => ({
          iso: s.time,
          formatted: formatSlotForDisplay(s.time, NZ_TIMEZONE),
        }));
        const slotMenuFormatted = slotMenu
          .map((s, i) => `${i + 1}. ${s.formatted}`)
          .join("\n");
        return {
          state: "AWAITING_SELECTION",
          collected: { ...collected, slotMenu, slotMenuFormatted },
        };
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    }

    const slots = await fetchPromise;
    const slotMenu = (slots ?? []).slice(0, 5).map((s) => ({
      iso: s.time,
      formatted: formatSlotForDisplay(s.time, NZ_TIMEZONE),
    }));
    const slotMenuFormatted = slotMenu
      .map((s, i) => `${i + 1}. ${s.formatted}`)
      .join("\n");
    return {
      state: "AWAITING_SELECTION",
      collected: { ...collected, slotMenu, slotMenuFormatted },
    };
  }

  /* ---------------------------------------------------------------- */
  /*  CREATING_CHECKOUT → Stripe session                               */
  /* ---------------------------------------------------------------- */
  private async handleCreatingCheckout(
    stripe: ReturnType<typeof createStripeClient>,
    db: Pool,
    collected: CollectedWithExtras,
    conversation: ConversationRow,
    holdingThresholdMs: number,
    locationId: string,
    contactId: string,
  ): Promise<{ state: ScmState; collected: CollectedWithExtras }> {
    const service =
      typeof collected.serviceKey === "string"
        ? getService(collected.serviceKey)
        : (collected.serviceKey as { key?: string; acuityTypeId?: number; paid?: boolean; price?: number; name?: string; calendarId?: string | number } | undefined);
    if (!service || !service.paid) {
      return { state: "BOOKING_ACUITY", collected };
    }

    const slotIso = collected.slotIso;
    if (!slotIso) return { state: "AWAITING_SELECTION", collected };

    /* Idempotency: check for existing payment session */
    const existing = await db.query<{ stripe_session_id: string; status: string }>(
      `SELECT stripe_session_id, status FROM payment_sessions
       WHERE conversation_id = $1 AND appointment_type_id = $2 AND slot_iso = $3
       ORDER BY created_at DESC
       LIMIT 1`,
      [conversation.id, String(service.acuityTypeId), slotIso],
    );
    if (existing.rows.length > 0 && existing.rows[0].status !== "expired") {
      const session = await stripe.getCheckoutSession(existing.rows[0].stripe_session_id);
      if (session.url) {
        return {
          state: "AWAITING_PAYMENT",
          collected: {
            ...collected,
            _paymentLink: session.url,
            _stripeSessionId: session.id,
          },
        };
      }
    }

    const checkoutPromise = stripe.createCheckoutSession({
      successUrl: this.deps.stripeSuccessUrl,
      cancelUrl: this.deps.stripeCancelUrl,
      lineItems: [
        {
          amount: (service.price ?? 0) * 100,
          currency: "nzd",
          name: service.name,
        },
      ],
      customerEmail: collected.email ?? undefined,
      clientReferenceId: contactId,
      metadata: {
        conversation_id: conversation.id,
        service_key: service.key ?? "",
        slot_iso: slotIso,
        contact_id: contactId,
        appointment_type_id: String(service.acuityTypeId),
        idempotency_key: `checkout-${conversation.id}-${slotIso}`,
      },
      paymentIntentData: {
        receipt_email: collected.email ?? undefined,
      },
    });

    const alreadySent =
      (conversation.context as Record<string, unknown>)?.holdingMessageSent ===
      true;

    if (!alreadySent) {
      const timer = setTimeout(async () => {
        try {
          await this.deps.ghl.sendMessage(locationId, contactId,
            buildGhlSendPayload("sms", contactId, conversation.ghl_conversation_id ?? undefined,
              sanitizeOutput(pickHoldingTemplate()))
          );
        } catch (e) {
          process.stderr.write("[conversation-service] holding message failed: " + String(e) + "\n");
        }
      }, holdingThresholdMs);

      try {
        const session = await checkoutPromise;
        clearTimeout(timer);
        await db.query(
          `INSERT INTO payment_sessions
           (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            session.id,
            session.status ?? "open",
            slotIso,
            String(service.acuityTypeId),
            contactId,
            conversation.id,
            `checkout-${conversation.id}-${slotIso}`,
            JSON.stringify(collected),
          ],
        );
        return {
          state: "AWAITING_PAYMENT",
          collected: {
            ...collected,
            _paymentLink: session.url,
            _stripeSessionId: session.id,
          },
        };
      } catch (err) {
        clearTimeout(timer);
        return this.diagnoseStripeError(err, collected);
      }
    }

    try {
      const session = await checkoutPromise;
      await db.query(
        `INSERT INTO payment_sessions
         (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          session.id,
          session.status ?? "open",
          slotIso,
          String(service.acuityTypeId),
          contactId,
          conversation.id,
          `checkout-${conversation.id}-${slotIso}`,
          JSON.stringify(collected),
        ],
      );
      return {
        state: "AWAITING_PAYMENT",
        collected: {
          ...collected,
          _paymentLink: session.url,
          _stripeSessionId: session.id,
        },
      };
    } catch (err) {
      return this.diagnoseStripeError(err, collected);
    }
  }

  private diagnoseStripeError(
    err: unknown,
    collected: CollectedWithExtras,
  ): { state: ScmState; collected: CollectedWithExtras } {
    const errMsg = String(err).toLowerCase();

    // Fatal Stripe errors (config, auth) — escalate
    if (
      errMsg.includes("api key") ||
      errMsg.includes("authentication") ||
      errMsg.includes("unauthorized") ||
      errMsg.includes("no such price") ||
      errMsg.includes("invalid") && errMsg.includes("currency")
    ) {
      return {
        state: "HUMAN_TOUCH",
        collected: { ...collected, _escalationReason: "stripe_config_error" },
      };
    }

    // Transient/network errors — already retried by Stripe client;
    // if still failing, escalate rather than loop forever.
    return {
      state: "HUMAN_TOUCH",
      collected: { ...collected, _escalationReason: "stripe_checkout_failed" },
    };
  }

  /* ---------------------------------------------------------------- */
  /*  BOOKING_ACUITY → create appointment                               */
  /* ---------------------------------------------------------------- */
  private async handleBookingAcuity(
    acuity: ReturnType<typeof createAcuityClient>,
    _db: Pool,
    collected: CollectedWithExtras,
    conversation: ConversationRow,
    _locationId: string,
    _contactId: string,
  ): Promise<{ state: ScmState; collected: CollectedWithExtras }> {
    const service =
      typeof collected.serviceKey === "string"
        ? getService(collected.serviceKey)
        : (collected.serviceKey as { key?: string; acuityTypeId?: number } | undefined);
    if (!service?.acuityTypeId) {
      return { state: "CONFIRMED", collected };
    }

    const slotIso = collected.slotIso;
    if (!slotIso) return { state: "AWAITING_SELECTION", collected };

    // Defense-in-depth gate: verify all mandatory fields are present even if
    // the transition gate somehow let this state be reached with missing data.
    const service_key = service.key ?? "";
    const gateCheck = gateApiCall(service.acuityTypeId, collected as Record<string, unknown>);
    if (!gateCheck.ready) {
      process.stderr.write(
        "[handleBookingAcuity] gate blocked — mandatory fields missing: " +
        gateCheck.missing.map((f: { key: string }) => f.key).join(", ") + "\n"
      );
      return {
        state: "COLLECTING" as ScmState,
        collected: {
          ...collected,
          missingFields: gateCheck.missing.map((f: { key: string }) => f.key),
        },
      };
    }

    const fullName = collected.fullName ?? "";
    const [firstName, ...lastNameParts] = fullName.split(" ");
    const lastName = lastNameParts.join(" ");

    const collectedFields = {
      firstName,
      lastName,
      patientName: fullName,
      email: collected.email,
      phone: collected.phone,
      dob: collected.dob,
      address: collected.address,
      questionsToDiscuss: collected.questions,
      currentMedications: collected.medications,
    };

    try {
      const appointment = await acuity.createAppointment({
        appointmentTypeID: service.acuityTypeId,
        datetime: slotIso,
        firstName,
        lastName,
        email: collected.email ?? "",
        phone: collected.phone,
        fields: mapIntakeFields(
          service.key ?? "",
          collectedFields as Parameters<typeof mapIntakeFields>[1],
        ),
        idempotencyKey: `scm-booking-${conversation.id}-${slotIso}`,
      });

      return {
        state: "CONFIRMED",
        collected: {
          ...collected,
          _acuityAppointmentId: String(appointment.id),
        },
      };
    } catch (err) {
      return this.diagnoseAcuityError(err, collected, service.acuityTypeId);
    }
  }

  private diagnoseAcuityError(
    err: unknown,
    collected: CollectedWithExtras,
    appointmentTypeId: number,
  ): { state: ScmState; collected: CollectedWithExtras } {
    const errMsg = String(err).toLowerCase();
    const errData = (err as Record<string, unknown>)?.data;
    const dataStr = typeof errData === "string" ? errData.toLowerCase() : JSON.stringify(errData).toLowerCase();
    const combined = `${errMsg} ${dataStr}`;

    // Config/auth errors — escalate immediately
    if (
      combined.includes("unauthorized") ||
      combined.includes("authentication") ||
      combined.includes("invalid api") ||
      combined.includes("wrong credentials") ||
      combined.includes("not found") && combined.includes("appointment type")
    ) {
      return {
        state: "HUMAN_TOUCH",
        collected: { ...collected, _escalationReason: "acuity_config_error" },
      };
    }

    // Field-level errors — loop back to COLLECTING with the bad field cleared
    const missingFields: string[] = [];
    const clearedCollected = { ...collected };

    if (combined.includes("date of birth") || combined.includes("dob")) {
      clearedCollected.dob = undefined;
      missingFields.push("dob");
    }
    if (combined.includes("phone") || combined.includes("mobile")) {
      clearedCollected.phone = undefined;
      missingFields.push("phone");
    }
    if (combined.includes("email")) {
      clearedCollected.email = undefined;
      missingFields.push("email");
    }
    if (combined.includes("datetime") || combined.includes("slot") || combined.includes("time")) {
      clearedCollected.slotIso = undefined;
      return {
        state: "SHOWING_SLOTS",
        collected: clearedCollected,
      };
    }

    if (missingFields.length > 0) {
      // Re-compute missing fields from gate
      const gate = gateApiCall(appointmentTypeId, clearedCollected as Record<string, unknown>);
      return {
        state: "COLLECTING",
        collected: {
          ...clearedCollected,
          missingFields: gate.ready ? missingFields : gate.missing.map((f: { key: string }) => f.key),
        },
      };
    }

    // Unknown/transient errors — already has retry in Acuity client;
    // if we got here, retries exhausted. Escalate.
    return {
      state: "HUMAN_TOUCH",
      collected: { ...collected, _escalationReason: "acuity_booking_failed" },
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Escalation                                                        */
  /* ---------------------------------------------------------------- */
  private async escalate(
    locationId: string,
    contactId: string,
    conversation: ConversationRow,
    reason: string,
  ): Promise<void> {
    const { db, ghl } = this.deps;

    /* Update conversation state */
    await updateConversation(db, conversation.id, "HUMAN_TOUCH", conversation.collected_fields as ScmCollected, {
      ...conversation.context,
      escalated: true,
      escalationReason: reason,
    } as Record<string, unknown>);

    /* Send escalation notice */
    try {
      await ghl.sendMessage(locationId, contactId,
        buildGhlSendPayload("sms", contactId, conversation.ghl_conversation_id ?? undefined,
          "I have passed this to a human coordinator who will be in touch shortly.")
      );
    } catch (e) {
      process.stderr.write("[conversation-service] escalation send failed: " + String(e) + "\n");
    }

    /* Update stage */
    await this.updateStage(locationId, contactId, "CONFIRMED", conversation.collected_fields as ScmCollected, true);
  }

  /* ---------------------------------------------------------------- */
  /*  GHL stage update                                                  */
  /* ---------------------------------------------------------------- */
  private async updateStage(
    locationId: string,
    contactId: string,
    state: ScmState,
    collected: ScmCollected,
    isEscalation = false,
  ): Promise<void> {
    const { ghl, ghlPipelineId } = this.deps;

    try {
      const opportunities = await ghl.getPipelineOpportunities(
        locationId,
        contactId,
        ghlPipelineId,
      );

      const serviceKeyRaw = collected.serviceKey;
      const serviceKeyStr =
        typeof serviceKeyRaw === "string"
          ? serviceKeyRaw
          : (serviceKeyRaw as { key?: string } | undefined)?.key;
      const targetStageId = isEscalation
        ? STAGE_HUMAN_TOUCH
        : stageIdForState(state, serviceKeyStr);

      if (!targetStageId) return;

      if (opportunities.length > 0) {
        const opp = opportunities[0];
        await ghl.updateOpportunityStageSafe(
          locationId,
          opp.id,
          targetStageId,
          opp.pipelineStageId,
          STAGE_HUMAN_TOUCH,
        );
      } else {
        await ghl.createOpportunity(locationId, {
          pipelineId: ghlPipelineId,
          pipelineStageId: targetStageId,
          locationId,
          contactId,
          name: (typeof collected.fullName === "string" && collected.fullName.trim()) || "New Lead",
          status: "open",
        });
      }
    } catch (err) {
      process.stderr.write("[conversation-service] stage update failed: " + String(err) + "\n");
    }
  }
}
