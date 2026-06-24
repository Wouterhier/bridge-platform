import type { ValidationResult } from "@romea/state-machine";
import { getService, services, type ServiceConfig } from "./services.js";

const FAKE_DOMAINS = new Set([
  "example.com",
  "localhost",
  "selfcaremen.booking",
]);

/* ── Date-of-birth normalizer ─────────────────────────────────────────── */

export type DobResult =
  | { ok: true; value: string }
  | { ok: false; ambiguous: true; hint: string }
  | { ok: false; error: string };

/**
 * Normalize a raw date-of-birth string to Acuity's expected "MM/DD/YYYY" format.
 *
 * - Accepts many human formats: "26/7/95", "July 26 1995", "1995-07-26",
 *   "26 Jul 1995", "26.07.1995", etc.
 * - Flags ambiguous dates (e.g. "09/06/1990") instead of guessing.
 * - Rejects impossible dates and implausible ages (< 16 or > 120).
 */
export function normalizeDob(raw: string): DobResult {
  const value = raw.trim();
  if (!value) {
    return { ok: false, error: "dob_required" };
  }

  // Try ISO-like first: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    const result = validateDateParts(year, month, day);
    if (!result.ok) return result;
    return { ok: true, value: formatDate(month, day, year) };
  }

  // Try slash-separated dates first: MM/DD/YYYY vs DD/MM/YYYY
  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const a = parseInt(slashMatch[1], 10);
    const b = parseInt(slashMatch[2], 10);
    let year = parseInt(slashMatch[3], 10);
    if (year < 100) year += year < 30 ? 2000 : 1900;

    if (b > 12) {
      // b cannot be a month → must be MM/DD/YYYY
      const result = validateDateParts(year, a, b);
      if (!result.ok) return result;
      return { ok: true, value: formatDate(a, b, year) };
    }

    if (a > 12) {
      // a cannot be a month → must be DD/MM/YYYY
      const result = validateDateParts(year, b, a);
      if (!result.ok) return result;
      return { ok: true, value: formatDate(b, a, year) };
    }

    // Both a and b ≤ 12 — ambiguous
    if (a !== b) {
      return {
        ok: false,
        ambiguous: true,
        hint: `${a}th of ${monthName(b)} or ${b}th of ${monthName(a)}?`,
      };
    }

    // a === b, so either interpretation is the same
    const result = validateDateParts(year, a, b);
    if (!result.ok) return result;
    return { ok: true, value: formatDate(a, b, year) };
  }

  // Try DD.MM.YYYY or DD-MM-YYYY (dot or dash — unambiguously DMY)
  const dmyMatch = value.match(/^(\d{1,2})[\.-](\d{1,2})[\.-](\d{2,4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    let year = parseInt(dmyMatch[3], 10);
    if (year < 100) year += year < 30 ? 2000 : 1900;

    // Ambiguity check: if both day and month are ≤ 12, flag it
    if (day <= 12 && month <= 12 && day !== month) {
      return {
        ok: false,
        ambiguous: true,
        hint: `${day}th of ${monthName(month)} or ${month}th of ${monthName(day)}?`,
      };
    }

    const result = validateDateParts(year, month, day);
    if (!result.ok) return result;
    return { ok: true, value: formatDate(month, day, year) };
  }

  // Try "DD Mon YYYY" or "Mon DD YYYY" or "Month DD YYYY"
  const monthDayYearMatch = value.match(
    /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,\s]+(\d{2,4})$/,
  );
  if (monthDayYearMatch) {
    const month = parseMonthName(monthDayYearMatch[1]);
    const day = parseInt(monthDayYearMatch[2], 10);
    let year = parseInt(monthDayYearMatch[3], 10);
    if (year < 100) year += year < 30 ? 2000 : 1900;
    if (month === 0) return { ok: false, error: "invalid_month" };
    const result = validateDateParts(year, month, day);
    if (!result.ok) return result;
    return { ok: true, value: formatDate(month, day, year) };
  }

  const dayMonthYearMatch = value.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)[,\s]+(\d{2,4})$/,
  );
  if (dayMonthYearMatch) {
    const day = parseInt(dayMonthYearMatch[1], 10);
    const month = parseMonthName(dayMonthYearMatch[2]);
    let year = parseInt(dayMonthYearMatch[3], 10);
    if (year < 100) year += year < 30 ? 2000 : 1900;
    if (month === 0) return { ok: false, error: "invalid_month" };
    const result = validateDateParts(year, month, day);
    if (!result.ok) return result;
    return { ok: true, value: formatDate(month, day, year) };
  }

  return { ok: false, error: "unrecognized_date_format" };
}

function monthName(month: number): string {
  const names = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return names[month] ?? "";
}

function parseMonthName(name: string): number {
  const lower = name.toLowerCase().slice(0, 3);
  const map: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  return map[lower] ?? 0;
}

function formatDate(month: number, day: number, year: number): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${m}/${d}/${year}`;
}

function validateDateParts(
  year: number,
  month: number,
  day: number,
): DobResult {
  if (month < 1 || month > 12) {
    return { ok: false, error: "invalid_month" };
  }
  if (day < 1 || day > daysInMonth(month, year)) {
    return { ok: false, error: "invalid_day" };
  }

  const dob = new Date(year, month - 1, day);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const mDiff = now.getMonth() - dob.getMonth();
  if (mDiff < 0 || (mDiff === 0 && now.getDate() < dob.getDate())) {
    age--;
  }

  if (age < 16) {
    return { ok: false, error: "too_young" };
  }
  if (age > 120) {
    return { ok: false, error: "implausible_age" };
  }

  return { ok: true, value: formatDate(month, day, year) };
}

function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate();
}

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

export type PhoneErrorKey = "too_short" | "invalid_chars";

/**
 * Validate and normalize a phone number to E.164 (+64...).
 *
 * - NZ is the default assumption. Numbers without a country code are
 *   treated as NZ numbers (02x mobile, 0x landline).
 * - Accepts +64 and 0064 prefixed numbers.
 * - Rejects non-numeric characters and numbers that are too short.
 */
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

  let normalized: string;
  if (trimmed.startsWith("+")) {
    normalized = `+${digits}`;
  } else if (trimmed.startsWith("00")) {
    normalized = `+${digits.slice(2)}`;
  } else {
    // No country code — assume NZ (+64)
    // NZ numbers start with 0 locally; strip the leading 0 and add +64
    if (digits.startsWith("0")) {
      normalized = `+64${digits.slice(1)}`;
    } else {
      // If no leading 0, just prepend +64 (e.g. "21 000 0000" → +64210000000)
      normalized = `+64${digits}`;
    }
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
  formatted?: string;
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
