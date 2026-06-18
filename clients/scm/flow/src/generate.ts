import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest, ModelRouter } from "@romea/model-router";
import { loadConfig } from "@romea/model-router";
import { createRouter } from "./model-router-factory.js";
import { getFallbackMessage } from "./fallback-messages.js";
import { getService, type ServiceConfig } from "./services.js";
import type { ScmCollected, ScmState } from "./states.js";

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  meta?: Record<string, unknown>;
}

interface GenerateOptions {
  router?: ModelRouter;
  kbPath?: string;
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function loadKnowledgeBase(kbPath?: string): string {
  const path = kbPath ?? resolve(__dirname, "../../kb/knowledge-base.md");
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "# SelfCareMen Knowledge Base\n\nSelfCareMen is a New Zealand men's telehealth clinic offering TRT, ED, GLP-1, RoidCare+, nutrition, and weight management consultations.";
  }
}

/* ── Clinician names from KB Section 8 (for stripping) ─────────────────── */
const clinicianNames = new Set([
  "Dominic Smith",
  "Dom Smith",
  "Josiah Tu'inukuafe",
  "Vijay Srivastava",
  "Sean Cameron",
  "Rokia Kone",
  "Jack Yeoman",
  "Jimmy Maslai",
  "Idris Anwar",
  "Tushar Srivastava",
  "Sonja de Jong",
  "Lisa Walker",
  "Thomas Wood",
]);

function containsClinicianName(text: string): boolean {
  const lower = text.toLowerCase();
  for (const name of clinicianNames) {
    if (lower.includes(name.toLowerCase())) return true;
  }
  return false;
}

/* ── Service facts injection ───────────────────────────────────────────── */
function resolveServiceConfig(collected: ScmCollected): ServiceConfig | undefined {
  const raw = collected.serviceKey;
  if (typeof raw === "string") return getService(raw);
  if (raw && typeof raw === "object" && "key" in raw) return raw as ServiceConfig;
  return undefined;
}

export function buildServiceFactsBlock(collected: ScmCollected): string {
  const svc = resolveServiceConfig(collected);
  if (!svc) return "";
  return [
    "--- SERVICE FACTS (code-provided, authoritative) ---",
    `Service: ${svc.name}`,
    `Duration: ${svc.duration} min`,
    `Price: ${svc.price === 0 ? "Free" : `NZD $${svc.price}`}`,
    "--- END SERVICE FACTS ---",
  ].join("\n");
}

/* ── Slot facts injection ──────────────────────────────────────────────── */
function buildSlotFactsBlock(collected: ScmCollected): string {
  if (!collected.slotMenuFormatted) return "";
  return [
    "--- SLOT FACTS (code-provided, authoritative) ---",
    collected.slotMenuFormatted,
    "--- END SLOT FACTS ---",
  ].join("\n");
}

function buildSelectedSlotFactsBlock(collected: ScmCollected): string {
  if (!collected.slotFormatted) return "";
  return [
    "--- SELECTED SLOT FACTS (code-provided, authoritative) ---",
    `Date/Time: ${collected.slotFormatted}`,
    "--- END SELECTED SLOT FACTS ---",
  ].join("\n");
}

/* ── Confirmed booking facts injection ─────────────────────────────────── */
export function buildConfirmedFacts(collected: ScmCollected): string {
  const svc = resolveServiceConfig(collected);
  if (!svc || !collected.slotFormatted) return "";
  return [
    "--- CONFIRMED BOOKING FACTS ---",
    `Patient: ${collected.fullName ?? ""}`,
    `Service: ${svc.name}`,
    `Date: ${collected.slotFormatted}`,
    `Duration: ${svc.duration} min`,
    `Price: ${svc.price === 0 ? "Free" : `NZD $${svc.price}`}`,
    "--- END CONFIRMED BOOKING FACTS ---",
  ].join("\n");
}

/* ── System prompt builder ─────────────────────────────────────────────── */
export function buildSystemPrompt(kb: string, state?: ScmState): string {
  const kbMode = process.env.KB_MODE ?? "inline";
  const parts = [
    "You are a senior patient coordinator at a top-tier men's telehealth clinic.",
    "",
    "## Style rules - follow exactly:",
    "- Never use em dashes (—). Use a period or a spaced hyphen instead.",
    "- Never open with \"Hey\" or \"Hey there\".",
    "- No exclamation points in the opening line.",
    "- No semicolons in SMS/chat/WhatsApp; split into two sentences.",
    "- Register: calm, precise, warm patient coordinator at a top-tier clinic. Never salesy.",
    "",
    "## Code-injected facts - OBEY these above all other sources:",
    "- Use ONLY the service name, duration, and price from the SERVICE FACTS block above. Do not use prices or service details from the knowledge base.",
    "- Echo the slot date/time EXACTLY as provided in the slot facts. Do not reformat, abbreviate, or change timezone.",
    "- Do not mention any clinician, doctor, or staff name in your response.",
    "",
    "## Payment-state language:",
    "- If the patient has NOT yet paid, the slot is HELD (e.g. \"held for 30 minutes\", \"on hold\"). Do NOT say the appointment is set, scheduled, confirmed, or booked.",
    "- Only after Stripe payment clears may you use confirmed/booked/scheduled language.",
    "",
    "## CRITICAL - Never write payment URLs:",
    "- NEVER include a payment URL, checkout link, or any stripe.com URL in your response.",
    "- The system appends the real payment link automatically after your message.",
    "- If you mention a payment link, say something like \"I have sent the payment link separately\" or \"Use the secure payment link we sent.\" Do NOT write the actual URL.",
    "",
    "## Role",
    "- Guide the patient through booking a consultation.",
    "- Be calm, precise, and warm.",
    "- Never be salesy or pushy.",
    "- If the patient is confused, clarify gently.",
    "",
    "## Style rules (hard rules)",
    "- Never use em dashes (— or --).",
    "- Never open a message with \"Hey\" or \"Hey there\".",
    "- No exclamation points in opening lines.",
    "- No semicolons in SMS/chat/WhatsApp output.",
    "- Keep messages concise and easy to read on a phone.",
    "- If payment has not yet cleared, tell the patient their slot is HELD (e.g. 'held for 30 minutes'). Never say the slot is 'set', 'confirmed', or 'booked' before payment clears. Avoid the words 'confirmed' and 'is set for' entirely in pre-payment messages.",
  ];

  if (state === "AWAITING_PAYMENT" || state === "CREATING_CHECKOUT") {
    parts.push("", "Reminder: payment has not cleared. Use 'held' language only.");
  }
  if (state === "CONFIRMED" || state === "BOOKING_ACUITY") {
    parts.push("", "Payment has cleared. Confirm the appointment normally.");
  }

  if (kbMode === "inline") {
    parts.push(
      "",
      "## Knowledge base",
      "NOTE: The knowledge base below is for general reference and illustrative purposes only. For the currently selected service's exact name, duration, and price, use ONLY the SERVICE FACTS block provided above.",
      kb,
    );
  }

  return parts.join("\n");
}

function buildStateInstruction(
  state: ScmState,
  collected: ScmCollected,
  errorKey?: string,
): string {
  const parts: string[] = [];

  switch (state) {
    case "NEW":
      parts.push("Welcome the patient and ask for their full name.");
      break;
    case "COLLECTING_NAME":
      if (errorKey) {
        parts.push(
          `The previous name was not accepted (reason: ${errorKey}). Politely ask them to provide their real full name (first and last).`,
        );
      } else {
        parts.push("Ask the patient for their full name (first and last).");
      }
      break;
    case "COLLECTING_PHONE":
      if (errorKey) {
        parts.push(
          `The previous phone number was not accepted (reason: ${errorKey}). Ask for a valid phone number including the country code.`,
        );
      } else {
        parts.push(
          `Ask ${collected.fullName ?? "the patient"} for their phone number, including country code.`,
        );
      }
      break;
    case "COLLECTING_EMAIL":
      if (errorKey) {
        parts.push(
          `The previous email was not accepted (reason: ${errorKey}). Ask for a valid email address.`,
        );
      } else {
        parts.push("Ask the patient for their email address.");
      }
      break;
    case "SELECTING_SERVICE":
      parts.push(
        "Ask which service the patient wants. List the available services briefly.",
      );
      break;
    case "SHOWING_SLOTS":
      parts.push(
        "Present the available appointment slots clearly and ask the patient to pick one.",
      );
      break;
    case "AWAITING_SELECTION":
      parts.push(
        "Wait for the patient to select a slot. If they reply without choosing, gently prompt them to pick one of the presented slots.",
      );
      break;
    case "CREATING_CHECKOUT":
      parts.push(
        "Tell the patient you are preparing a secure payment link for their appointment. Remind them their slot is held while payment is pending.",
      );
      break;
    case "AWAITING_PAYMENT":
      parts.push(
        "The payment is pending. Remind the patient their slot is held. Do NOT include a payment link or any URL - the system will add the real one automatically.",
      );
      break;
    case "BOOKING_ACUITY":
      parts.push(
        "Tell the patient you are finalising their booking in the calendar.",
      );
      break;
    case "CONFIRMED":
      parts.push(
        "Confirm the booking warmly. Include the appointment details if known.",
      );
      break;
  }

  if (Object.keys(collected).length > 0) {
    const collectedSummary = JSON.stringify(collected, (_k, v) =>
      typeof v === "object" && v !== null && "key" in v ? v.key : v,
    );
    parts.push(`Collected so far: ${collectedSummary}`);
  }

  return parts.join("\n");
}

export function compactHistory(history: HistoryMessage[]): string[] {
  return history.map((h) => {
    if (h.role === "system" && h.meta?.event) {
      return `system [${h.meta.event}]: ${h.content}`;
    }
    return `${h.role}: ${h.content}`;
  });
}

function structuredWarn(action: string, detected: unknown, context: string) {
  process.stderr.write(JSON.stringify({
    action,
    detected,
    context: context.slice(0, 80),
  }) + "\n");
}

/* ── Unsanctioned contact-info stripper ────────────────────────────────── */
function stripUnsanctionedContactInfo(
  text: string,
  sanctionedUrls: string[],
): string {
  let result = text;

  // First pass: replace unsanctioned URLs with a temporary marker
  const urlRegex = /https?:\/\/[^\s)"\]]+/g;
  result = result.replace(urlRegex, (match) => {
    if (sanctionedUrls.some((u) => match.startsWith(u))) return match;
    structuredWarn("stripper.url", match, text);
    return "__UNSCTIONED_URL__";
  });

  // Strip entire sentences containing the unsanctioned-URL marker
  result = result.replace(/[^.!?\n]*__UNSCTIONED_URL__[^.!?\n]*/g, "");

  // Strip entire sentences containing email patterns
  result = result.replace(/[^.!?\n]*\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b[^.!?\n]*/gi, "");

  // Remove whole sentences containing phone patterns
  result = result.replace(/[^.!?\n]+[.!?]*/g, (match) => {
    const phoneMatch = match.match(
      /(?:\+\d{1,3}[-.\s()]*)?\(?\d{2,4}\)?[-.\s]*\d{3,4}[-.\s]*\d{3,4}/,
    );
    if (phoneMatch) {
      const digits = phoneMatch[0].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) {
        // Don't strip bare sequences of digits without phone-like separators
        const raw = phoneMatch[0];
        if (!raw.startsWith("+") && !/[()\s-]/.test(raw)) {
          return match;
        }
        structuredWarn("stripper.phone", raw, match.trim());
        return "";
      }
    }
    return match;
  });
  // Collapse double blank lines/whitespace after stripping
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  // Strip clinician names if they appear
  if (containsClinicianName(result)) {
    for (const name of clinicianNames) {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      result = result.replace(re, "[name removed]");
    }
  }

  // Collapse double whitespace and newlines after sentence stripping
  result = result.replace(/\n{3,}/g, "\n\n").replace(/ {2,}/g, " ").trim();

  return result;
}

export function sanitizeOutput(
  text: string,
  state?: ScmState,
  collected?: ScmCollected,
): string {
  /* Enforce style rules that models sometimes ignore */
  let sanitized = (
    text
      /* Replace em dashes and standalone double dashes */
      .replace(/—/g, " - ")
      .replace(/\b--\b/g, " - ")
      /* Replace semicolons with periods */
      .replace(/;/g, ".")
  );

  /* Strip unsanctioned contact info */
  if (collected) {
    const extras = collected as Record<string, unknown>;
    const sanctionedUrls = [(extras._paymentLink as string)].filter(Boolean) as string[];
    sanitized = stripUnsanctionedContactInfo(sanitized, sanctionedUrls);
  }

  /* Warn on pre-payment commitment words instead of rewriting (lets conditional/future clauses through) */
  if (state === "AWAITING_PAYMENT" || state === "CREATING_CHECKOUT") {
    const commitmentWords = ["confirmed", "booked", "scheduled", "finalised", "finalized"];
    const lower = sanitized.toLowerCase();
    for (const word of commitmentWords) {
      if (lower.includes(word)) {
        structuredWarn("injector.commitmentWord", word, sanitized);
      }
    }
  }

  /* Post-generation slot echo check */
  if (collected?.slotFormatted && !sanitized.includes(collected.slotFormatted)) {
    structuredWarn("injector.slotEchoMismatch", collected.slotFormatted, sanitized);
  }

  return sanitized;
}

async function callGenerate(
  router: ModelRouter,
  req: ModelRequest,
  state?: ScmState,
  collected?: ScmCollected,
): Promise<string> {
  try {
    const res = await router.complete("generate", req);
    return sanitizeOutput(res.text.trim(), state, collected);
  } catch {
    try {
      const fallbackRes = await router.complete("generate", {
        ...req,
        temperature: 0.7,
      });
      return sanitizeOutput(fallbackRes.text.trim(), state, collected);
    } catch {
      throw new Error("generate failed");
    }
  }
}

export async function generate(
  state: ScmState,
  collected: ScmCollected = {},
  history: HistoryMessage[] = [],
  _kb?: string,
  errorKey?: string,
  options: GenerateOptions = {},
): Promise<string> {
  const kb = loadKnowledgeBase(options.kbPath);
  const system = buildSystemPrompt(kb, state);
  const stateInstruction = buildStateInstruction(state, collected, errorKey);

  /* Build injected facts blocks */
  const factsParts: string[] = [];

  const serviceFacts = buildServiceFactsBlock(collected);
  if (serviceFacts) factsParts.push(serviceFacts);

  const slotFacts = buildSlotFactsBlock(collected);
  if (slotFacts) factsParts.push(slotFacts);

  const selectedSlotFacts = buildSelectedSlotFactsBlock(collected);
  if (selectedSlotFacts) factsParts.push(selectedSlotFacts);

  if (state === "CONFIRMED" || state === "BOOKING_ACUITY") {
    const confirmedFacts = buildConfirmedFacts(collected);
    if (confirmedFacts) factsParts.push(confirmedFacts);
  }

  const userContent = [
    ...(factsParts.length > 0 ? [factsParts.join("\n\n"), ""] : []),
    "Current task:",
    stateInstruction,
    "",
    "Conversation so far:",
    ...compactHistory(history),
    "",
    "Generate the next patient-facing message. Return only the message text. Do not include JSON, code fences, or stage labels.",
  ].join("\n");

  const messages: HistoryMessage[] = [
    ...history,
    {
      role: "user",
      content: userContent,
    },
  ];

  const router = options.router ?? createRouter(loadConfig());

  const req: ModelRequest = {
    role: "generate",
    system,
    messages,
    temperature: 0.7,
    maxTokens: 1024,
  };

  try {
    return await callGenerate(router, req, state, collected);
  } catch {
    return getFallbackMessage(state);
  }
}
