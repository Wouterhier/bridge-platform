import { FIELD_SPECS, type FieldSpec, type AppointmentTypeSpec } from "./field-spec.js";
import { normalizeDob, validatePhone, validateEmail, validateName } from "./validators.js";

export interface GateResultReady {
  ready: true;
  payload: Record<string, string>;
}

export interface GateResultBlocked {
  ready: false;
  missing: FieldSpec[];
}

export type GateResult = GateResultReady | GateResultBlocked;

/**
 * Base fields that are mandatory for ANY booking, regardless of appointment type.
 * These are not Acuity custom fields; they are passed as top-level appointment params.
 */
const BASE_MANDATORY_FIELDS: FieldSpec[] = [
  { id: 0, key: "fullName", label: "full name", requirement: "mandatory", type: "text" },
  { id: 0, key: "phone", label: "phone number", requirement: "mandatory", type: "phone" },
  { id: 0, key: "email", label: "email address", requirement: "mandatory", type: "email" },
];

/**
 * Deterministic gate: before calling any booking API, verify every mandatory
 * field is present and passes type-specific validation.
 *
 * - Checks base fields (fullName, phone, email) for ALL types.
 * - Checks per-type custom mandatory fields (e.g. dob) from FIELD_SPECS.
 * - Optional fields are NOT checked; post_booking fields are NOT checked.
 * - Returns ready=false with the list of missing/invalid fields if any fail.
 */
export function gateApiCall(
  appointmentTypeId: number,
  collected: Record<string, unknown>,
): GateResult {
  const spec = getFieldSpec(appointmentTypeId);
  const allMandatory = [
    ...BASE_MANDATORY_FIELDS,
    ...(spec?.fields.filter((f) => f.requirement === "mandatory") ?? []),
  ];

  const missing: FieldSpec[] = [];

  for (const field of allMandatory) {
    const raw = collected[field.key];
    if (raw === undefined || raw === null || raw === "") {
      missing.push(field);
      continue;
    }
    const valid = validateField(field, String(raw));
    if (!valid) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return { ready: false, missing };
  }

  return { ready: true, payload: buildValidatedPayload(appointmentTypeId, collected) };
}

function validateField(field: FieldSpec, raw: string): boolean {
  switch (field.type) {
    case "date":
      return normalizeDob(raw).ok;
    case "phone":
      return validatePhone(raw).ok;
    case "email":
      return validateEmail(raw).ok;
    case "text":
      return raw.trim().length > 0;
    case "enum":
      return raw.trim().length > 0;
    default:
      return raw.trim().length > 0;
  }
}

function getFieldSpec(appointmentTypeId: number): AppointmentTypeSpec | undefined {
  return FIELD_SPECS[appointmentTypeId];
}

/**
 * Build a clean, normalized payload from collected fields.
 *
 * - Includes ALL mandatory fields (guaranteed valid by gateApiCall).
 * - Includes optional fields only if present and valid.
 * - Excludes post_booking fields (collected after booking).
 * - Normalizes values to canonical formats (E.164 phone, MM/DD/YYYY dob, etc.).
 */
export function buildValidatedPayload(
  appointmentTypeId: number,
  collected: Record<string, unknown>,
): Record<string, string> {
  const spec = getFieldSpec(appointmentTypeId);
  const payload: Record<string, string> = {};

  // Base fields — always normalize
  if (collected.fullName !== undefined && collected.fullName !== "") {
    const nameResult = validateName(String(collected.fullName));
    if (nameResult.ok) payload.fullName = nameResult.value;
  }
  if (collected.phone !== undefined && collected.phone !== "") {
    const phoneResult = validatePhone(String(collected.phone));
    if (phoneResult.ok) payload.phone = phoneResult.value;
  }
  if (collected.email !== undefined && collected.email !== "") {
    const emailResult = validateEmail(String(collected.email));
    if (emailResult.ok) payload.email = emailResult.value;
  }

  // Custom fields from spec
  const allFields = spec?.fields ?? [];
  for (const field of allFields) {
    if (field.requirement === "post_booking") continue;

    const raw = collected[field.key];
    if (raw === undefined || raw === null || raw === "") continue;

    const normalized = normalizeCustomField(field, String(raw));
    if (normalized !== undefined) {
      payload[field.key] = normalized;
    }
  }

  return payload;
}

function normalizeCustomField(field: FieldSpec, raw: string): string | undefined {
  switch (field.type) {
    case "date": {
      const result = normalizeDob(raw);
      if (result.ok) return result.value;
      return undefined;
    }
    case "phone": {
      const result = validatePhone(raw);
      if (result.ok) return result.value;
      return undefined;
    }
    case "email": {
      const result = validateEmail(raw);
      if (result.ok) return result.value;
      return undefined;
    }
    case "text":
    case "enum":
      return raw.trim();
    default:
      return raw.trim();
  }
}
