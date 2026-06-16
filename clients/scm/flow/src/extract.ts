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
    "Extract the patient's name from their message.",
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
  const parsed = parseJson(res.text);

  if (parsed === null || isEmptyResult(parsed)) {
    // Escalate to stronger model for ambiguous/null extraction.
    const escalation = await router.escalate("extract", req);
    const escalatedParsed = parseJson(escalation.text);
    if (escalatedParsed === null || isEmptyResult(escalatedParsed)) {
      return null;
    }
    return escalatedParsed as ExtractionHint;
  }

  return parsed as ExtractionHint;
}
