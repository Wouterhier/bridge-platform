import type { StateMachineConfig } from "@romea/state-machine";
import {
  validateEmail,
  validateName,
  validatePhone,
  validateService,
  validateSlotSelection,
  type SlotMenuItem,
} from "./validators.js";
import { getService, type ServiceConfig } from "./services.js";
import { gateApiCall } from "./gate.js";

export type ScmState =
  | "NEW"
  | "ENGAGING"
  | "SELECTING_SERVICE"
  | "COLLECTING"
  | "SHOWING_SLOTS"
  | "AWAITING_SELECTION"
  | "CREATING_CHECKOUT"
  | "AWAITING_PAYMENT"
  | "BOOKING_ACUITY"
  | "CONFIRMED"
  | "HUMAN_TOUCH";

export type ScmField =
  | "fullName"
  | "phone"
  | "email"
  | "serviceKey"
  | "slotIso";

export interface ScmCollected {
  fullName?: string;
  phone?: string;
  email?: string;
  dob?: string;
  dobRaw?: string;
  serviceKey?: string | ServiceConfig;
  slotIso?: string;
  slotMenu?: SlotMenuItem[];
  slotMenuFormatted?: string;
  slotFormatted?: string;
  missingFields?: string[];
  bookingIntent?: boolean;
}

export interface ScmContext {
  paymentReceived?: boolean;
}

function ok() {
  return { ok: true as const };
}

function computeMissingFields(collected: ScmCollected): string[] {
  const missing: string[] = [];
  const cfg =
    typeof collected.serviceKey === "string"
      ? getService(collected.serviceKey)
      : (collected.serviceKey as ServiceConfig | undefined);

  if (!cfg) return missing;

  const gate = gateApiCall(cfg.acuityTypeId, collected as Record<string, unknown>);
  if (!gate.ready) {
    return gate.missing.map((f) => f.key);
  }
  return missing;
}

function missingFieldsText(collected: ScmCollected): string {
  const missing = collected.missingFields ?? [];
  if (missing.length === 0) return "";

  const labels: Record<string, string> = {
    fullName: "your full name",
    phone: "a phone number",
    email: "your email address",
    dob: "your date of birth",
    address: "your address",
    medications: "your current medications",
    medicalHistory: "your medical history",
    questions: "any questions you'd like to discuss",
  };

  const items = missing.map((k) => labels[k] ?? k);
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export function createScmStateMachineConfig(): StateMachineConfig<
  ScmState,
  ScmField,
  ScmContext
> {
  return {
    initialState: "NEW",
    states: {
      NEW: {
        id: "NEW",
        validate: () => ok(),
        next: () => "ENGAGING",
        buildPromptContext: () =>
          "Welcome the patient warmly. Let them know you can help them book a consultation or answer questions. Keep it low-pressure and natural.",
      },
      ENGAGING: {
        id: "ENGAGING",
        validate: () => ok(),
        next: (collected) => {
          const c = collected as unknown as ScmCollected;
          if (c.bookingIntent) return "SELECTING_SERVICE";
          return "ENGAGING";
        },
        buildPromptContext: (collected) => {
          const c = collected as unknown as ScmCollected;
          const name = c.fullName ?? "";
          return [
            "Engage with the patient naturally. Answer questions, build a little rapport, and gently guide toward booking if they show interest.",
            name ? `You know their name is ${name}.` : "",
            "If they clearly express booking intent (e.g. 'I want to book', 'schedule me in', 'sign up'), the system will advance to service selection.",
            "Do NOT demand personal details. Only ask for what's needed when there's genuine booking intent.",
          ]
            .filter(Boolean)
            .join(" ");
        },
      },
      SELECTING_SERVICE: {
        id: "SELECTING_SERVICE",
        requiredField: "serviceKey",
        validate: (raw) => validateService(raw),
        next: () => "COLLECTING",
        buildPromptContext: (collected) => {
          const cfg = collected.serviceKey as ServiceConfig | undefined;
          const c = collected as unknown as ScmCollected;
          const name = c.fullName ?? "";
          return [
            `Help the patient choose the right consultation.`,
            cfg ? `They have selected: ${cfg.name}` : "Briefly mention the main options (TRT, ED, GLP-1, RoidCare+, nutrition, weight management) and ask which fits what they are looking for.",
            name ? `Their name is ${name}.` : "",
          ]
            .filter(Boolean)
            .join(" ");
        },
      },
      COLLECTING: {
        id: "COLLECTING",
        validate: () => ok(),
        next: (collected) => {
          const c = collected as unknown as ScmCollected;
          const cfg =
            typeof c.serviceKey === "string"
              ? getService(c.serviceKey)
              : (c.serviceKey as ServiceConfig | undefined);
          if (!cfg) return "SELECTING_SERVICE";

          const gate = gateApiCall(cfg.acuityTypeId, collected as Record<string, unknown>);
          if (gate.ready) return "SHOWING_SLOTS";
          return "COLLECTING";
        },
        buildPromptContext: (collected) => {
          const c = collected as unknown as ScmCollected;
          const missingText = missingFieldsText(c);
          const cfg =
            typeof c.serviceKey === "string"
              ? getService(c.serviceKey)
              : (c.serviceKey as ServiceConfig | undefined);

          if (!missingText) {
            return `All details collected for ${cfg?.name ?? "the consultation"}. Present available slots.`;
          }

          return [
            `To book the ${cfg?.name ?? "consultation"}, you still need: ${missingText}.`,
            "Ask naturally, combining questions where possible. Frame everything around helping them get booked in.",
            "If they already provided some of this in earlier messages, do NOT re-ask it.",
          ].join(" ");
        },
      },
      SHOWING_SLOTS: {
        id: "SHOWING_SLOTS",
        validate: () => ok(),
        next: () => "AWAITING_SELECTION",
        buildPromptContext: (collected) => {
          const cfg = collected.serviceKey as ServiceConfig | undefined;
          return `Present the available appointment times (from the SLOT FACTS block, exactly as written) for ${cfg?.name ?? "selected service"} in a clear, friendly way, and invite them to pick one.`;
        },
      },
      AWAITING_SELECTION: {
        id: "AWAITING_SELECTION",
        requiredField: "slotIso",
        validate: (raw, collected) =>
          validateSlotSelection(raw, (collected as unknown as ScmCollected).slotMenu ?? []),
        next: (collected) => {
          const raw = (collected as unknown as ScmCollected).serviceKey;
          const cfg: ServiceConfig | undefined =
            typeof raw === "string" ? getService(raw) : (raw as ServiceConfig | undefined);
          if (cfg && !cfg.paid) {
            return "BOOKING_ACUITY";
          }
          return "CREATING_CHECKOUT";
        },
        buildPromptContext: (collected) => {
          const cfg = collected.serviceKey as ServiceConfig | undefined;
          return `Wait for the patient to select a slot for ${cfg?.name ?? ""}. If they haven't picked one yet, warmly nudge them to choose from the times shown.`;
        },
      },
      CREATING_CHECKOUT: {
        id: "CREATING_CHECKOUT",
        validate: () => ok(),
        next: () => "AWAITING_PAYMENT",
        buildPromptContext: (collected) =>
          `Create a Stripe checkout session for the selected paid appointment. Collected: ${JSON.stringify(
            collected,
          )}`,
      },
      AWAITING_PAYMENT: {
        id: "AWAITING_PAYMENT",
        validate: () => ok(),
        next: (_collected, context) =>
          context?.paymentReceived ? "BOOKING_ACUITY" : "AWAITING_PAYMENT",
        buildPromptContext: () =>
          "Payment is pending. Send the patient the payment link and wait for confirmation.",
      },
      BOOKING_ACUITY: {
        id: "BOOKING_ACUITY",
        validate: () => ok(),
        next: () => "CONFIRMED",
        buildPromptContext: (collected) =>
          `Book the appointment in Acuity. Collected: ${JSON.stringify(collected)}`,
      },
      CONFIRMED: {
        id: "CONFIRMED",
        validate: () => ok(),
        next: () => "CONFIRMED",
        buildPromptContext: () => "Confirm the booking to the patient.",
      },
      HUMAN_TOUCH: {
        id: "HUMAN_TOUCH",
        validate: () => ok(),
        next: () => "HUMAN_TOUCH",
        buildPromptContext: () => "A human coordinator is handling this conversation.",
      },
    },
  };
}
