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

export type ScmState =
  | "NEW"
  | "COLLECTING_NAME"
  | "COLLECTING_PHONE"
  | "COLLECTING_EMAIL"
  | "SELECTING_SERVICE"
  | "SHOWING_SLOTS"
  | "AWAITING_SELECTION"
  | "CREATING_CHECKOUT"
  | "AWAITING_PAYMENT"
  | "BOOKING_ACUITY"
  | "CONFIRMED";

export type ScmField =
  | "fullName"
  | "phone"
  | "email"
  | "serviceKey"
  | "slotIso";

export interface ScmCollected extends Partial<Record<ScmField, unknown>> {
  fullName?: string;
  phone?: string;
  email?: string;
  serviceKey?: string | ServiceConfig;
  slotIso?: string;
  slotMenu?: SlotMenuItem[];
  slotMenuFormatted?: string;
  slotFormatted?: string;
}

export interface ScmContext {
  paymentReceived?: boolean;
}

function ok() {
  return { ok: true as const };
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
        next: () => "COLLECTING_NAME",
        buildPromptContext: () => "Welcome the patient and ask for their full name.",
      },
      COLLECTING_NAME: {
        id: "COLLECTING_NAME",
        requiredField: "fullName",
        validate: (raw) => validateName(raw),
        next: () => "COLLECTING_PHONE",
        buildPromptContext: (collected) =>
          `Ask for the patient's phone number. Collected name: ${collected.fullName ?? ""}`,
      },
      COLLECTING_PHONE: {
        id: "COLLECTING_PHONE",
        requiredField: "phone",
        validate: (raw) => validatePhone(raw),
        next: () => "COLLECTING_EMAIL",
        buildPromptContext: (collected) =>
          `Ask for the patient's email. Collected: ${JSON.stringify({
            fullName: collected.fullName,
            phone: collected.phone,
          })}`,
      },
      COLLECTING_EMAIL: {
        id: "COLLECTING_EMAIL",
        requiredField: "email",
        validate: (raw) => validateEmail(raw),
        next: () => "SELECTING_SERVICE",
        buildPromptContext: (collected) =>
          `Ask which service the patient wants. Collected: ${JSON.stringify({
            fullName: collected.fullName,
            phone: collected.phone,
            email: collected.email,
          })}`,
      },
      SELECTING_SERVICE: {
        id: "SELECTING_SERVICE",
        requiredField: "serviceKey",
        validate: (raw) => validateService(raw),
        next: () => "SHOWING_SLOTS",
        buildPromptContext: (collected) => {
          const cfg = collected.serviceKey as ServiceConfig | undefined;
          return `Show available appointment slots for ${cfg?.name ?? "selected service"}.`;
        },
      },
      SHOWING_SLOTS: {
        id: "SHOWING_SLOTS",
        validate: () => ok(),
        next: () => "AWAITING_SELECTION",
        buildPromptContext: (collected) => {
          const cfg = collected.serviceKey as ServiceConfig | undefined;
          return `Present the slot menu and ask the patient to pick one. Service: ${cfg?.name ?? ""}.`;
        },
      },
      AWAITING_SELECTION: {
        id: "AWAITING_SELECTION",
        requiredField: "slotIso",
        validate: (raw, collected) =>
          validateSlotSelection(raw, (collected as ScmCollected).slotMenu ?? []),
        next: (collected) => {
          const raw = (collected as ScmCollected).serviceKey;
          const cfg: ServiceConfig | undefined =
            typeof raw === "string" ? getService(raw) : (raw as ServiceConfig | undefined);
          if (cfg && !cfg.paid) {
            return "BOOKING_ACUITY";
          }
          return "CREATING_CHECKOUT";
        },
        buildPromptContext: (collected) => {
          const cfg = collected.serviceKey as ServiceConfig | undefined;
          return `Wait for the patient to select a slot. Service: ${cfg?.name ?? ""}.`;
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
    },
  };
}
