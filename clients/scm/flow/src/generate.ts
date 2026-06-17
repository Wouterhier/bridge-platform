import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelRequest, ModelRouter } from "@romea/model-router";
import { loadConfig } from "@romea/model-router";
import { createRouter } from "./model-router-factory.js";
import { getFallbackMessage } from "./fallback-messages.js";
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

function loadKnowledgeBase(kbPath?: string): string {
  const path = kbPath ?? resolve(process.cwd(), "clients/scm/kb/knowledge-base.md");
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "# SelfCareMen Knowledge Base\n\nSelfCareMen is a New Zealand men's telehealth clinic offering TRT, ED, GLP-1, RoidCare+, nutrition, and weight management consultations.";
  }
}

export function buildSystemPrompt(kb: string, state?: ScmState): string {
  const kbMode = process.env.KB_MODE ?? "inline";
  const parts = [
    "You are a senior patient coordinator at a top-tier men's telehealth clinic.",
    "",
    "## Style rules — follow exactly:",
    "- Never use em dashes (—). Use a period or a spaced hyphen instead.",
    "- Never open with \"Hey\" or \"Hey there\".",
    "- No exclamation points in the opening line.",
    "- No semicolons in SMS/chat/WhatsApp; split into two sentences.",
    "- Register: calm, precise, warm patient coordinator at a top-tier clinic. Never salesy.",
    "",
    "## Payment-state language:",
    "- If the patient has NOT yet paid, the slot is HELD (e.g. \"held for 30 minutes\", \"on hold\"). Do NOT say the appointment is set, scheduled, confirmed, or booked.",
    "- Only after Stripe payment clears may you use confirmed/booked/scheduled language.",
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
    parts.push("", "## Knowledge base", kb);
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
        "The payment is pending. Share the payment link and remind the patient their slot is held.",
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

function sanitizeOutput(text: string, state?: ScmState): string {
  /* Enforce style rules that models sometimes ignore */
  let sanitized = (
    text
      /* Replace em dashes and standalone double dashes */
      .replace(/—/g, " - ")
      .replace(/\b--\b/g, " - ")
      /* Replace semicolons with periods */
      .replace(/;/g, ".")
  );

  /* Only strip pre-payment 'confirmed' / 'booked' / 'scheduled' / 'set' language in pre-payment states */
  if (state === "AWAITING_PAYMENT" || state === "CREATING_CHECKOUT") {
    sanitized = sanitized
      .replace(/\bwill be confirmed\b/gi, "will be held")
      .replace(/\bis confirmed\b/gi, "is held")
      .replace(/\bconfirmed\b/gi, "held")
      .replace(/\bwill be booked\b/gi, "will be held")
      .replace(/\bis booked\b/gi, "is held")
      .replace(/\bbooked\b/gi, "held")
      .replace(/\bwill be scheduled\b/gi, "will be held")
      .replace(/\bis scheduled\b/gi, "is held")
      .replace(/\bscheduled\b/gi, "held")
      .replace(/\bis set for\b/gi, "is held for")
      .replace(/\bis set\b/gi, "is held")
      .replace(/\bset for\b/gi, "held for")
      .replace(/\bset\b/gi, "held")
      .replace(/\bfinalised\b/gi, "held")
      .replace(/\bfinalized\b/gi, "held");
  }

  return sanitized;
}

async function callGenerate(
  router: ModelRouter,
  req: ModelRequest,
  state?: ScmState,
): Promise<string> {
  try {
    const res = await router.complete("generate", req);
    return sanitizeOutput(res.text.trim(), state);
  } catch {
    try {
      const fallbackRes = await router.complete("generate", {
        ...req,
        temperature: 0.7,
      });
      return sanitizeOutput(fallbackRes.text.trim(), state);
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

  const messages: HistoryMessage[] = [
    ...history,
    {
      role: "user",
      content: [
        "Current task:",
        stateInstruction,
        "",
        "Conversation so far:",
        ...compactHistory(history),
        "",
        "Generate the next patient-facing message. Return only the message text. Do not include JSON, code fences, or stage labels.",
      ].join("\n"),
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
    return await callGenerate(router, req, state);
  } catch {
    return getFallbackMessage(state);
  }
}
