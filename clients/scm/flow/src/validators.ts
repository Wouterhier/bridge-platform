import type { ValidationResult } from "@romea/state-machine";
import { getService, services, type ServiceConfig } from "./services.js";

const FAKE_DOMAINS = new Set([
  "example.com",
  "test.com",
  "localhost",
  "selfcaremen.booking",
]);

// AI-mutation defense is in the state machine engine: this validator runs
// against the patient's raw message, not the AI's output. We only validate
// format and block fake domains here. Plus-addressing (local+tag@domain) is
// valid and must not be rejected.
//
// Robust but not over-engineered RFC-ish local-part regex.
const EMAIL_LOCAL_PART_RE = /^[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~.-]+$/;
const EMAIL_DOMAIN_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function validateEmail(raw: string): ValidationResult<string> {
  const original = raw;
  const value = original.trim().toLowerCase();

  if (value.length === 0) {
    return { ok: false, error: "email_required" };
  }

  const atIndex = value.indexOf("@");
  if (atIndex === -1) {
    return { ok: false, error: "invalid_email" };
  }

  const local = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);

  if (
    local.length === 0 ||
    domain.length === 0 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.startsWith(".") ||
    domain.endsWith(".")
  ) {
    return { ok: false, error: "invalid_email" };
  }

  if (!EMAIL_LOCAL_PART_RE.test(local) || !EMAIL_DOMAIN_RE.test(domain)) {
    return { ok: false, error: "invalid_email" };
  }

  if (FAKE_DOMAINS.has(domain)) {
    return { ok: false, error: "fake_domain" };
  }

  // Return exactly what the patient typed, lowercased and trimmed only.
  return { ok: true, value };
}

export type PhoneErrorKey = "too_short" | "no_country" | "invalid_chars";

export function validatePhone(raw: string): ValidationResult<string> {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: "too_short" as PhoneErrorKey };
  }

  if (/[a-zA-Z]/.test(trimmed)) {
    return { ok: false, error: "invalid_chars" as PhoneErrorKey };
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8) {
    return { ok: false, error: "too_short" as PhoneErrorKey };
  }

  const hasCountryIndicator = trimmed.startsWith("+") || trimmed.startsWith("00");
  if (!hasCountryIndicator) {
    return { ok: false, error: "no_country" as PhoneErrorKey };
  }

  let normalized: string;
  if (trimmed.startsWith("+")) {
    normalized = `+${digits}`;
  } else {
    // starts with 00
    normalized = `+${digits.slice(2)}`;
  }

  return { ok: true, value: normalized };
}

const PLACEHOLDER_NAMES = new Set([
  "guest",
  "visitor",
  "test",
  "user",
  "name",
  "firstname",
  "lastname",
]);

const PLACEHOLDER_FULL_NAMES = new Set([
  "guest visitor",
  "test user",
  "guest user",
  "test visitor",
]);

export function validateName(raw: string): ValidationResult<string> {
  const value = raw.trim().replace(/\s+/g, " ");

  if (value.length === 0) {
    return { ok: false, error: "name_required" };
  }

  // Reject values that look like emails or phone numbers.
  if (value.includes("@") || /^\+?[\d\s().-]+$/.test(value)) {
    return { ok: false, error: "invalid_name" };
  }

  const words = value.split(" ");
  if (words.length < 2) {
    return { ok: false, error: "first_last_required" };
  }

  if (words.some((w) => w.length < 2)) {
    return { ok: false, error: "name_too_short" };
  }

  const lower = value.toLowerCase();
  if (PLACEHOLDER_FULL_NAMES.has(lower)) {
    return { ok: false, error: "placeholder_name" };
  }

  if (words.some((w) => PLACEHOLDER_NAMES.has(w.toLowerCase()))) {
    return { ok: false, error: "placeholder_name" };
  }

  return { ok: true, value };
}

export function validateService(raw: string): ValidationResult<ServiceConfig> {
  const key = raw.trim().toLowerCase();

  if (key === "vasectomy" || key === "vasectomy_initial") {
    return { ok: false, error: "service_unavailable" };
  }

  const service = getService(key);
  if (!service) {
    return { ok: false, error: "unknown_service" };
  }

  return { ok: true, value: service };
}

export interface SlotMenuItem {
  iso: string;
}

export function validateSlotSelection(
  raw: string,
  slotMenu: SlotMenuItem[] = [],
): ValidationResult<string> {
  const value = raw.trim();

  if (value.length === 0) {
    return { ok: false, error: "slot_required" };
  }

  const allowed = slotMenu.map((s) => s.iso);
  if (!allowed.includes(value)) {
    return { ok: false, error: "invalid_slot" };
  }

  return { ok: true, value };
}
