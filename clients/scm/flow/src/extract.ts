import type { ModelRequest, ModelResponse, ModelRouter } from "@romea/model-router";
import { loadConfig } from "@romea/model-router";
import { createRouter } from "./model-router-factory.js";
import type { ScmCollected, ScmState } from "./states.js";
import { services } from "./services.js";

export interface ExtractionHint {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  phone?: string;
  email?: string;
  serviceKey?: string;
  slotIso?: string;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface ExtractOptions {
  router?: ModelRouter;
}

function buildServiceList(): string {
  return Object.values(services)
    .map((s) => `- ${s.key}: ${s.name}`)
    .join("\n");
}

function buildNamePrompt(rawMessage: string, history: HistoryMessage[]): string {
  return [
    "Extract the patient's full name from their message.",
    "Return ONLY a JSON object in one of these forms:",
    '{"firstName": "...", "lastName": "..."}',
    'or {"fullName": "..."}',
    "If no name is present, return {}.",
    "",
    "Conversation history:",
    ...history.map((h) => `${h.role}: ${h.content}`),
    "",
    `Patient message: "${rawMessage}"`,
  ].join("\n");
}

function buildPhonePrompt(rawMessage: string, history: HistoryMessage[]): string {
  return [
    "Extract the patient's phone number from their message.",
    'Return ONLY a JSON object like {"phone": "..."}.',
    "Preserve the original formatting if present. If no phone number is present, return {}.",
    "",
    "Conversation history:",
    ...history.map((h) => `${h.role}: ${h.content}`),
    "",
    `Patient message: "${rawMessage}"`,
  ].join("\n");
}

function buildEmailPrompt(rawMessage: string, history: HistoryMessage[]): string {
  return [
    "Extract the patient's email address from their message.",
    'Return ONLY a JSON object like {"email": "..."}.',
    "Return the email in lowercase. If no email is present, return {}.",
    "",
    "Conversation history:",
    ...history.map((h) => `${h.role}: ${h.content}`),
    "",
    `Patient message: "${rawMessage}"`,
  ].join("\n");
}

function buildServicePrompt(rawMessage: string, history: HistoryMessage[]): string {
  return [
    "Extract which service the patient wants from their message.",
    'Return ONLY a JSON object like {"serviceKey": "..."}.',
    "Use one of the exact service keys below. If the patient mentions a service by name, map it to the matching key. If no service is mentioned, return {}.",
    "",
    "Available services:",
    buildServiceList(),
    "",
    "Conversation history:",
    ...history.map((h) => `${h.role}: ${h.content}`),
    "",
    `Patient message: "${rawMessage}"`,
  ].join("\n");
}

function buildSlotPrompt(
  rawMessage: string,
  history: HistoryMessage[],
  slotMenu: { iso: string }[],
): string {
  const slots = slotMenu.map((s) => s.iso).join("\n");
  return [
    "Extract which appointment slot the patient selected from their message.",
    'Return ONLY a JSON object like {"slotIso": "..."}.',
    "The slotIso must be one of the ISO timestamps presented below. If the patient says something like \"the first slot\" or \"tomorrow at 9am\", map it to the closest matching ISO timestamp. If no slot can be determined, return {}.",
    "",
    "Presented slots:",
    slots || "(none)",
    "",
    "Conversation history:",
    ...history.map((h) => `${h.role}: ${h.content}`),
    "",
    `Patient message: "${rawMessage}"`,
  ].join("\n");
}

function buildPrompt(
  state: ScmState,
  rawMessage: string,
  collected: ScmCollected,
  history: HistoryMessage[],
): string | null {
  switch (state) {
    case "COLLECTING_NAME":
      return buildNamePrompt(rawMessage, history);
    case "COLLECTING_PHONE":
      return buildPhonePrompt(rawMessage, history);
    case "COLLECTING_EMAIL":
      return buildEmailPrompt(rawMessage, history);
    case "SELECTING_SERVICE":
      return buildServicePrompt(rawMessage, history);
    case "AWAITING_SELECTION":
      return buildSlotPrompt(rawMessage, history, collected.slotMenu ?? []);
    case "NEW":
    case "SHOWING_SLOTS":
    case "CREATING_CHECKOUT":
    case "AWAITING_PAYMENT":
    case "BOOKING_ACUITY":
    case "CONFIRMED":
      return null;
    default:
      return null;
  }
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```json\s*|\s*```$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function isEmptyResult(result: unknown): boolean {
  if (result === null || result === undefined) return true;
  if (typeof result !== "object") return false;
  return Object.keys(result as Record<string, unknown>).length === 0;
}

async function callExtract(
  router: ModelRouter,
  req: ModelRequest,
): Promise<ModelResponse> {
  try {
    return await router.complete("extract", req);
  } catch (err) {
    // If both primary and fallback fail, escalate once.
    return router.escalate("extract", req);
  }
}

// ── Regex fallback extractors ───────────────────────────────────────────────

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+\d{1,3}[-.\s]?)?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/;
const NAME_RE = /(?:my name is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i;

function regexExtractEmail(raw: string): string | null {
  const m = raw.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

function regexExtractPhone(raw: string): string | null {
  const m = raw.match(PHONE_RE);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  if (digits.length < 8) return null;
  return m[0];
}

function regexExtractName(raw: string): { firstName: string; lastName: string } | { fullName: string } | null {
  const m = raw.match(NAME_RE);
  if (m) {
    const parts = m[1].trim().split(/\s+/);
    if (parts.length >= 2) {
      return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
    }
  }
  // Fallback: look for two capitalized words
  const fm = raw.match(/([A-Z][a-z]+)\s+([A-Z][a-z]+)/);
  if (fm) {
    return { firstName: fm[1], lastName: fm[2] };
  }
  return null;
}

// ── Service key fuzzy resolver ──────────────────────────────────────────────

export function resolveServiceKey(raw: string): string | null {
  const input = raw.trim().toLowerCase();
  if (!input) return null;

  // 1. Direct key match
  if (services[input]) return input;

  // 2. Explicit rejections
  if (input === "vasectomy" || input.includes("vasectom")) return null;

  // 3. Free eligibility
  if (input.includes("free eligibility") || input.includes("eligibility check") || input === "eligibility") {
    return "free_eligibility";
  }

  // 4. TRT
  const isTrt = input.includes("trt") || input.includes("testosterone");
  if (isTrt) {
    if (input.includes("initial") || input.includes("first") || input.includes("consult")) return "trt_initial";
    if (input.includes("follow") || input.includes("follow-up")) return "trt_followup";
    if (input.includes("on treatment") || input.includes("ongoing") || input.includes("on-treatment")) return "trt_ontreatment";
    if (input.includes("express")) return "trt_express";
    // Default TRT → initial
    return "trt_initial";
  }

  // 5. ED / Erectile
  const isEd = input.includes("ed") || input.includes("erectile");
  if (isEd) {
    if (input.includes("initial") || input.includes("first") || input.includes("consult")) return "ed_initial";
    return "ed_initial";
  }

  // 6. GLP-1 / Semaglutide
  const isGlp = input.includes("glp") || input.includes("glp-1") || input.includes("semaglutide");
  if (isGlp) {
    if (input.includes("initial") || input.includes("first") || input.includes("consult")) return "glp1_initial";
    if (input.includes("follow")) return "glp1_followup";
    return "glp1_initial";
  }

  // 7. RoidCare / SARM / PED / Steroid
  const isRoid = input.includes("roid") || input.includes("sarm") || input.includes("ped") || input.includes("steroid");
  if (isRoid) {
    if (input.includes("initial") || input.includes("first") || input.includes("consult")) return "roidcare_initial";
    if (input.includes("follow")) return "roidcare_followup";
    return "roidcare_initial";
  }

  // 8. Nutrition
  const isNutrition = input.includes("nutrition");
  if (isNutrition) {
    if (input.includes("initial") || input.includes("first") || input.includes("consult")) return "nutrition_initial";
    if (input.includes("follow")) return "nutrition_followup";
    return "nutrition_initial";
  }

  // 9. Weight management
  const isWeight = input.includes("weight") || input.includes("weight management");
  if (isWeight) {
    if (input.includes("initial") || input.includes("first") || input.includes("consult")) return "weightmgmt_initial";
    if (input.includes("follow")) return "weightmgmt_followup";
    return "weightmgmt_initial";
  }

  // 10. Fuzzy name match against service names
  for (const svc of Object.values(services)) {
    const svcName = svc.name.toLowerCase();
    // Direct substring match in either direction
    if (svcName.includes(input) || input.includes(svcName)) return svc.key;
    // Word-level overlap
    const inputWords = new Set(input.split(/\s+/));
    const svcWords = svcName.split(/\s+/);
    const overlap = svcWords.filter((w) => inputWords.has(w)).length;
    if (overlap >= 2) return svc.key;
  }

  return null;
}

// ── Main extraction function ────────────────────────────────────────────────

export async function extract(
  state: ScmState,
  rawMessage: string,
  history: HistoryMessage[] = [],
  collected: ScmCollected = {},
  options: ExtractOptions = {},
): Promise<ExtractionHint | null> {
  const prompt = buildPrompt(state, rawMessage, collected, history);
  if (prompt === null) return null;

  const router = options.router ?? createRouter(loadConfig());

  const req: ModelRequest = {
    role: "extract",
    system:
      "You are a precise structured-data extractor for a medical clinic booking flow. Return ONLY valid JSON objects. Do not include markdown code fences or explanatory text.",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    maxTokens: 512,
    responseFormat: { type: "json_object" },
  };

  const res = await callExtract(router, req);
  let parsed = parseJson(res.text);

  if (parsed === null || isEmptyResult(parsed)) {
    // Escalate to stronger model for ambiguous/null extraction.
    const escalation = await router.escalate("extract", req);
    const escalatedParsed = parseJson(escalation.text);
    if (escalatedParsed === null || isEmptyResult(escalatedParsed)) {
      parsed = null;
    } else {
      parsed = escalatedParsed;
    }
  }

  const hint = (parsed ?? {}) as ExtractionHint;

  // ── Post-processing: regex fallbacks ────────────────────────────────────
  if (state === "COLLECTING_EMAIL" && !hint.email) {
    const fallback = regexExtractEmail(rawMessage);
    if (fallback) hint.email = fallback;
  }
  if (state === "COLLECTING_PHONE" && !hint.phone) {
    const fallback = regexExtractPhone(rawMessage);
    if (fallback) hint.phone = fallback;
  }
  if (state === "COLLECTING_NAME" && !hint.firstName && !hint.fullName) {
    const fallback = regexExtractName(rawMessage);
    if (fallback) Object.assign(hint, fallback);
  }

  // ── Post-processing: service key resolution ─────────────────────────────
  if (state === "SELECTING_SERVICE" && hint.serviceKey) {
    const resolved = resolveServiceKey(hint.serviceKey);
    if (resolved) {
      hint.serviceKey = resolved;
    } else {
      // If resolveServiceKey returns null, clear it so the engine re-prompts.
      delete hint.serviceKey;
    }
  }

  // If nothing was extracted at all, return null.
  if (isEmptyResult(hint)) return null;

  return hint;
}
