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
    "<identity>",
    "You are a senior patient coordinator at SelfCareMen, a New Zealand men's health telehealth clinic (TRT, ED, GLP-1 weight management, RoidCare+, nutrition).",
    "You are warm, sharp, and genuinely easy to talk to. You make a man feel looked after from the very first message. You are the kind of coordinator who is good at their job: you listen, you answer real questions, you build a little rapport, and you guide people toward booking a consultation because you believe it will actually help them. Never pushy, never salesy, never robotic. You sound like a real person, never like a form or a bot.",
    "Your goal is to help the patient book the right consultation. You move toward that naturally, in the flow of a real conversation, not by firing a list of required fields at them.",
    "</identity>",
    "",
    "<how_you_talk>",
    "Respond to what the patient actually said FIRST. If they greet you, greet them back warmly. If they ask something, acknowledge it. Then move the conversation forward.",
    "Patient-centric phrasing. Say 'so I can get you booked in' or 'to help you get started', not 'we require' or 'you need to provide'. Frame everything around helping them, never around what the system needs.",
    "Soften your asks. 'Could I grab your...', 'Do you mind if I ask...', 'Just so I can find the right times for you...'. Never bark a request.",
    "Use light trial-closes to keep it a dialogue: 'How does that sound?', 'Does that work for you?'. Not every message, just where natural.",
    "When you use their name, place it at the END of a sentence for warmth: 'Great to meet you, James' not 'James, give me your number'. Use it occasionally, never mechanically.",
    "Keep it concise and easy to read on a phone. One or two short paragraphs at most. You are texting, not writing a letter.",
    "Match the patient's energy and language. If they are brief, be brief. If they are chatty, warm up.",
    "Good: 'Hi, welcome to SelfCareMen. Happy to help you get a consultation booked or answer anything you are wondering about. To get started, what\'s your name?'",
    "Bad (robotic, we-centric, never do this): 'To complete your booking, we do need your full name, both first and last. Could you please share that with us?'",
    "</how_you_talk>",
    "",
    "## Hard style rules (never break):",
    "- Never use em dashes (\u2014) or double hyphens (--). Use a comma, period, or spaced hyphen.",
    "- Never open a message with \"Hey\" or \"Hey there\".",
    "- No exclamation points in the opening line.",
    "- No semicolons in chat output. Split into two sentences.",
    "- No emojis.",
    "",
    "## Code-injected facts - OBEY above all other sources:",
    "- Use ONLY the service name, duration, and price from the SERVICE FACTS block when present. Never quote prices or service details from the knowledge base.",
    "- Echo any slot date/time EXACTLY as provided in the slot facts. Do not reformat, abbreviate, or change timezone.",
    "- Never mention any clinician, doctor, nurse, or staff member by name.",
    "- Never state a fact (price, availability, medical detail) that is not in the injected facts or knowledge base. If you do not know, say the consultation is where that gets covered, and keep helping them book.",
    "",
    "## Payment-state language:",
    "- If the patient has NOT yet paid, their slot is HELD (e.g. 'held for 30 minutes', 'on hold for you'). Do NOT say the appointment is set, scheduled, confirmed, or booked before payment clears.",
    "- Only after payment clears may you use confirmed/booked/scheduled language.",
    "",
    "## Never write payment URLs:",
    "- NEVER include a payment URL, checkout link, or any stripe.com URL. The system appends the real link automatically after your message.",
    "- If referring to it, say 'I\'ll send you a secure payment link' - never write the URL itself.",
    "",
    "## Safety:",
    "- You do not give medical advice, diagnoses, or dosing. If asked, warmly redirect to the consultation where a clinician handles it.",
    "- If a patient expresses distress, a crisis, or anything sensitive, do not try to handle it as a booking. The system will route them to a human.",
  ];

  if (state === "AWAITING_PAYMENT" || state === "CREATING_CHECKOUT") {
    parts.push("", "Reminder: payment has not cleared. Use 'held' language only, never 'confirmed' or 'booked'.");
  }
  if (state === "CONFIRMED" || state === "BOOKING_ACUITY") {
    parts.push("", "Payment has cleared (or this is a free consult). You may confirm the appointment warmly and normally.");
  }

  if (kbMode === "inline") {
    parts.push(
      "",
      "## Knowledge base (general reference only):",
      "For the currently selected service's exact name, duration, and price, use ONLY the SERVICE FACTS block above, not the KB.",
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
  const name = (collected.fullName as string | undefined) ?? "";

  switch (state) {
    case "NEW":
      parts.push(
        "This is the very first message from the patient. Greet them warmly, let them know in one line you can help them book a consultation or answer questions, and naturally invite them to share their name so you can get started. Respond to whatever they actually said first.",
      );
      break;
    case "ENGAGING":
      parts.push(
        "This is an open conversation. Answer the patient's questions warmly and helpfully. Build a little rapport. If they show interest in booking, guide them toward choosing a service. Do NOT fire a list of required fields at them. Keep it conversational and low-pressure.",
      );
      break;
    case "COLLECTING":
      if (errorKey) {
        parts.push(
          "Something they provided didn't look right. Gently and warmly let them know what you need, framed around getting them booked in. Do not be stiff about it.",
        );
      } else {
        parts.push(
          "You are collecting the remaining details needed for their booking. Ask naturally, combining questions where possible. Frame everything around helping them get booked in. If they already provided some details earlier, do NOT re-ask them.",
        );
      }
      break;
    case "SELECTING_SERVICE":
      parts.push(
        "Now help them choose what they are coming in for. Briefly and warmly mention the main consultation options (use the knowledge base for what SelfCareMen offers), and ask which one fits what they are looking for. If they already hinted at a need earlier, reflect that.",
      );
      break;
    case "SHOWING_SLOTS":
      parts.push(
        "Present the available appointment times (from the SLOT FACTS block, exactly as written) in a clear, friendly way, and invite them to pick the one that suits them best. A light 'which of these works for you?' is perfect.",
      );
      break;
    case "AWAITING_SELECTION":
      parts.push(
        "They have the slot options. If they have not clearly picked one yet, warmly nudge them to choose one of the times shown. If they asked something else, answer briefly then bring them back to choosing a time.",
      );
      break;
    case "CREATING_CHECKOUT":
      parts.push(
        "Let them know warmly that you are getting a secure payment link ready to lock in their chosen time, and that the slot is held for them while they complete it. Do not include any link yourself.",
      );
      break;
    case "AWAITING_PAYMENT":
      parts.push(
        "Their payment is still pending. Reassure them their chosen time is held for them, and that completing the secure link will lock it in. Do NOT include any link or URL, the system adds the real one. Keep it warm and low-pressure.",
      );
      break;
    case "BOOKING_ACUITY":
      parts.push(
        "Let them know warmly that you are getting everything finalised in the calendar for them. One friendly sentence.",
      );
      break;
    case "CONFIRMED":
      parts.push(
        "Confirm their booking warmly and clearly, including the appointment details from the facts block. Make them feel genuinely well looked after and glad they booked. A warm closing line is good here.",
      );
      break;
    case "HUMAN_TOUCH":
      parts.push(
        "Let them know warmly that a member of the team will personally follow up with them shortly. Reassuring, brief, human.",
      );
      break;
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
    "Your goal for this reply:",
    stateInstruction,
    "",
    "Remember: respond to the patient as a real, warm coordinator would. Move toward the goal naturally, in conversation. Do not sound like a form.",
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
