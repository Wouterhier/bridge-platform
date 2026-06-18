import { Buffer } from "node:buffer";
import type { Db } from "@romea/bridge-db";
import {
  findPaymentSessionByIdempotencyKey,
  markAppointmentCreated,
} from "@romea/bridge-db";

export interface AcuityClientConfig {
  userId: string;
  apiKey: string;
  baseUrl?: string;
  db?: Db;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface AcuityAppointmentType {
  id: number;
  name: string;
  duration: number;
  price: string;
  [key: string]: unknown;
}

export interface AcuityAvailabilitySlot {
  time: string;
  [key: string]: unknown;
}

export interface AcuityFormField {
  id: number | string;
  value: string | number | boolean;
}

export interface AcuityAppointment {
  id: number;
  type?: string;
  appointmentTypeID?: number;
  datetime?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  forms?: Array<{ id?: number; values?: AcuityFormField[] }>;
  [key: string]: unknown;
}

export interface AcuityCreateAppointmentPayload {
  appointmentTypeID: number;
  datetime: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  calendarID?: string | number;
  fields?: AcuityFormField[];
  certificate?: string;
  idempotencyKey?: string;
  paymentSessionId?: string;
  [key: string]: unknown;
}

export interface AcuityAvailabilityParams {
  calendarID?: string | number;
  date?: string;
  month?: string;
  appointmentTypeID?: number;
  [key: string]: unknown;
}

const DEFAULT_BASE_URL = "https://acuityscheduling.com/api/v1";
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [500, 1500, 4000]; // exponential-ish backoff

export function createAcuityClient(config: AcuityClientConfig) {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const auth = Buffer.from(`${config.userId}:${config.apiKey}`).toString(
    "base64",
  );
  const db = config.db;
  const logger = config.logger;
  const inFlight = new Map<string, Promise<AcuityAppointment>>();

  if (!config.userId || !config.apiKey) {
    throw new Error("ACUITY_USER_ID and ACUITY_API_KEY are required");
  }

  function headers(): Record<string, string> {
    return {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  function isHtmlResponse(response: Response, text: string): boolean {
    const ct = response.headers.get("content-type") ?? "";
    if (ct.toLowerCase().includes("text/html")) return true;
    if (text.trim().toLowerCase().startsWith("<!doctype html")) return true;
    if (text.trim().toLowerCase().startsWith("<html")) return true;
    return false;
  }

  async function requestWithRetry<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
    options: { allowEmptyOnHtml?: boolean } = {},
  ): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), baseUrl + "/");
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const init: RequestInit = {
        method,
        headers: headers(),
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      try {
        const response = await fetch(url.toString(), init);
        const text = await response.text();

        // HTML detection
        if (isHtmlResponse(response, text)) {
          logger?.warn("Acuity returned HTML response", {
            url: url.toString(),
            status: response.status,
            attempt: attempt + 1,
            preview: text.slice(0, 200),
          });
          if (options.allowEmptyOnHtml) {
            return [] as unknown as T;
          }
          lastError = new AcuityApiError(
            `Acuity returned HTML (status ${response.status})`,
            response.status,
            { raw: text.slice(0, 500) },
          );
          // Retry on HTML
          if (attempt < MAX_RETRIES - 1) {
            await sleep(RETRY_DELAYS_MS[attempt] ?? 4000);
            continue;
          }
          throw lastError;
        }

        let data: unknown;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }

        if (!response.ok) {
          throw new AcuityApiError(
            `Acuity API error: ${response.status} ${response.statusText}`,
            response.status,
            data,
          );
        }
        return data as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Only retry on network errors or 5xx (not 4xx client errors)
        const isNetworkError = !(err instanceof AcuityApiError);
        const isServerError = err instanceof AcuityApiError && err.status >= 500;
        const isHtmlError = err instanceof AcuityApiError && err.message.includes("HTML");
        if ((isNetworkError || isServerError || isHtmlError) && attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 4000);
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new Error("Acuity request failed after retries");
  }

  return {
    async getAppointmentTypes(): Promise<AcuityAppointmentType[]> {
      return requestWithRetry<AcuityAppointmentType[]>("GET", "/appointment-types");
    },

    async getAvailability(
      appointmentTypeId: number,
      params: AcuityAvailabilityParams = {},
    ): Promise<AcuityAvailabilitySlot[]> {
      try {
        return await requestWithRetry<AcuityAvailabilitySlot[]>(
          "GET",
          "/availability/times",
          undefined,
          {
            appointmentTypeID: appointmentTypeId,
            ...params,
          },
        );
      } catch (err) {
        // If we got HTML or unparseable after retries, return empty slots
        // so the state machine can re-prompt.
        if (
          err instanceof AcuityApiError &&
          (err.message.includes("HTML") || err.status >= 500)
        ) {
          logger?.warn("getAvailability returning empty after HTML/error", {
            appointmentTypeId,
            params,
            error: err.message,
          });
          return [];
        }
        throw err;
      }
    },

    async createAppointment(
      payload: AcuityCreateAppointmentPayload,
    ): Promise<AcuityAppointment> {
      const {
        idempotencyKey,
        paymentSessionId,
        ...acuityPayload
      } = payload;

      if (idempotencyKey) {
        if (!db) {
          throw new Error(
            "AcuityClient: db is required when idempotencyKey is provided",
          );
        }

        // Deduplicate concurrent calls with the same idempotency key.
        const existingFlight = inFlight.get(idempotencyKey);
        if (existingFlight) {
          return existingFlight;
        }

        // Build the flight promise synchronously so inFlight is set before
        // any await that would yield control to a concurrent caller.
        const flightPromise = (async () => {
          // Idempotency: replay protection for webhook-vs-poll race.
          const existing = await findPaymentSessionByIdempotencyKey(
            db,
            idempotencyKey,
          );
          if (existing?.acuity_appointment_id) {
            const appointmentId = Number(existing.acuity_appointment_id);
            return getAppointment(appointmentId);
          }

          const appointment = await requestWithRetry<AcuityAppointment>(
            "POST",
            "/appointments",
            acuityPayload,
          );

          // Persist the Acuity appointment id against the payment session.
          if (appointment.id != null) {
            if (paymentSessionId) {
              await markAppointmentCreated(db, paymentSessionId, appointment.id);
            } else {
              const session = await findPaymentSessionByIdempotencyKey(
                db,
                idempotencyKey,
              );
              if (session) {
                await markAppointmentCreated(db, session.id, appointment.id);
              }
            }
          }

          return appointment;
        })();

        inFlight.set(idempotencyKey, flightPromise);

        try {
          return await flightPromise;
        } finally {
          inFlight.delete(idempotencyKey);
        }
      }

      return requestWithRetry<AcuityAppointment>("POST", "/appointments", acuityPayload);
    },

    async getAppointment(id: number): Promise<AcuityAppointment> {
      return requestWithRetry<AcuityAppointment>("GET", `/appointments/${id}`);
    },

    async updateAppointmentFormFields(
      id: number,
      fields: AcuityFormField[],
    ): Promise<AcuityAppointment> {
      return requestWithRetry<AcuityAppointment>("PUT", `/appointments/${id}`, { fields });
    },
  };

  async function getAppointment(id: number): Promise<AcuityAppointment> {
    return requestWithRetry<AcuityAppointment>("GET", `/appointments/${id}`);
  }
}

export function createShadowAcuityClient(config: AcuityClientConfig) {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const db = config.db;
  const logger = config.logger;

  if (!config.userId || !config.apiKey) {
    throw new Error("ACUITY_USER_ID and ACUITY_API_KEY are required");
  }

  function shadowLog(action: string, params: Record<string, unknown>) {
    const entry = { shadow: true, action, ...params };
    if (logger) {
      logger.info("SHADOW: would have " + action, entry);
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  return {
    async getAppointmentTypes(): Promise<AcuityAppointmentType[]> {
      return [];
    },

    async getAvailability(
      appointmentTypeId: number,
      params: AcuityAvailabilityParams = {},
    ): Promise<AcuityAvailabilitySlot[]> {
      return [];
    },

    async createAppointment(
      payload: AcuityCreateAppointmentPayload,
    ): Promise<AcuityAppointment> {
      const {
        idempotencyKey,
        paymentSessionId,
        ...acuityPayload
      } = payload;

      shadowLog("acuity.createAppointment", { idempotencyKey, ...acuityPayload });
      return {
        id: 999999,
        type: String(acuityPayload.appointmentTypeID),
        ...acuityPayload,
      } as AcuityAppointment;
    },

    async getAppointment(id: number): Promise<AcuityAppointment> {
      return { id } as AcuityAppointment;
    },

    async updateAppointmentFormFields(
      id: number,
      fields: AcuityFormField[],
    ): Promise<AcuityAppointment> {
      shadowLog("acuity.updateAppointmentFormFields", { id, fields });
      return { id, fields } as AcuityAppointment;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AcuityApiError extends Error {
  public readonly status: number;
  public readonly data: unknown;

  constructor(
    message: string,
    status: number,
    data: unknown,
  ) {
    super(message);
    this.name = "AcuityApiError";
    this.status = status;
    this.data = data;
  }
}

export function acuityClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  db?: Db,
): ReturnType<typeof createAcuityClient> {
  return createAcuityClient({
    userId: env.ACUITY_USER_ID ?? "",
    apiKey: env.ACUITY_API_KEY ?? "",
    db,
  });
}

export interface CollectedFields {
  firstName?: string;
  lastName?: string;
  patientName?: string;
  dob?: string;
  address?: string;
  consultationType?: string;
  gpName?: string;
  currentMedications?: string;
  questionsToDiscuss?: string;
  height?: string;
  weight?: string;
  allergies?: string;
  medicalConditions?: string;
  referralSource?: string;
  [key: string]: unknown;
}

/**
 * Map collected conversation fields to Acuity intake form fields for a
 * given service key / appointment type.
 *
 * Field ids are taken from the verified SelfCareMen Acuity configuration.
 */
export function mapIntakeFields(
  serviceKey: string,
  collected: CollectedFields,
): AcuityFormField[] {
  const service = services[serviceKey];
  if (!service) {
    throw new Error(`Unknown service key: ${serviceKey}`);
  }

  const patientName =
    collected.patientName ||
    `${collected.firstName ?? ""} ${collected.lastName ?? ""}`.trim() ||
    "Not provided";
  const dob = collected.dob || "01/01/1990";
  const address = collected.address || "Not provided";
  const consultType =
    service.name.replace(" Consultation", "").replace(" Follow-up", "") ||
    "Consultation";
  const meds = collected.currentMedications || "None";
  const gpName = collected.gpName || "";
  const questionsToDiscuss = collected.questionsToDiscuss || "";

  const apptId = String(service.acuityTypeId);

  // FREE ELIGIBILITY (79429909) — form 2966861
  if (apptId === "79429909") {
    return [
      { id: 16440628, value: "yes" },
      { id: 16762638, value: dob },
      { id: 16763392, value: address },
      { id: 16736078, value: consultType },
      { id: 16736084, value: questionsToDiscuss },
    ];
  }

  // TRT INITIAL/FOLLOWUP/ON-TREATMENT (53224493, 53721340, 88117019)
  if (["53224493", "53721340", "88117019"].includes(apptId)) {
    return [
      { id: 16440628, value: "yes" },
      { id: 13992148, value: patientName },
      { id: 14056070, value: dob },
      { id: 18249027, value: "Acknowledged" },
      { id: 13992150, value: address },
      { id: 13992159, value: gpName },
      { id: 13992164, value: meds },
    ];
  }

  // TRT EXPRESS (76832356) — own T&C
  if (apptId === "76832356") {
    return [
      { id: 16438224, value: "yes" },
      { id: 16440628, value: "yes" },
      { id: 13992148, value: patientName },
      { id: 14056070, value: dob },
      { id: 18249027, value: "Acknowledged" },
    ];
  }

  // ROIDCARE INITIAL/FOLLOWUP (53693767, 80478945)
  if (["53693767", "80478945"].includes(apptId)) {
    return [
      { id: 16440628, value: "yes" },
      { id: 18235349, value: patientName },
      { id: 18235350, value: dob },
      { id: 18235352, value: address },
      { id: 13992148, value: patientName },
      { id: 14056070, value: dob },
      { id: 18249027, value: "Acknowledged" },
    ];
  }

  // GLP-1 INITIAL/FOLLOWUP (80075841, 80576455)
  if (["80075841", "80576455"].includes(apptId)) {
    return [
      { id: 16440628, value: "yes" },
      { id: 18235376, value: patientName },
      { id: 18235377, value: dob },
      { id: 18235378, value: address },
      { id: 13992148, value: patientName },
      { id: 14056070, value: dob },
      { id: 18249027, value: "Acknowledged" },
    ];
  }

  // HAIRLOSS (76386980, 76387044)
  if (["76386980", "76387044"].includes(apptId)) {
    return [
      { id: 16440628, value: "yes" },
      { id: 16762638, value: dob },
      { id: 16763392, value: address },
      { id: 16736078, value: "Hair Loss" },
    ];
  }

  // NUTRITION/WEIGHT MGMT (88945263, 90895435, 90895750, 90895811)
  if (["88945263", "90895435", "90895750", "90895811"].includes(apptId)) {
    return [
      { id: 16440628, value: "yes" },
      { id: 18227621, value: patientName },
      { id: 18227624, value: address },
      { id: 16934757, value: dob },
      { id: 16934759, value: collected.height || "175" },
      { id: 16934760, value: collected.weight || "75" },
      { id: 18227641, value: meds },
      { id: 18227644, value: collected.allergies || "None known" },
      { id: 18227645, value: collected.medicalConditions || "None" },
      { id: 18227676, value: collected.referralSource || "Chat" },
      { id: 18227662, value: consultType },
    ];
  }

  // Fallback: free-eligibility-style fields.
  return [
    { id: 16440628, value: "yes" },
    { id: 16762638, value: dob },
    { id: 16763392, value: address },
    { id: 16736078, value: consultType },
  ];
}

interface ServiceConfig {
  key: string;
  acuityTypeId: number;
  name: string;
}

const services: Record<string, ServiceConfig> = {
  free_eligibility: {
    key: "free_eligibility",
    acuityTypeId: 79429909,
    name: "Free Eligibility Consultation",
  },
  trt_initial: {
    key: "trt_initial",
    acuityTypeId: 53224493,
    name: "TRT Initial Consultation",
  },
  trt_followup: {
    key: "trt_followup",
    acuityTypeId: 53721340,
    name: "TRT Follow-up",
  },
  trt_ontreatment: {
    key: "trt_ontreatment",
    acuityTypeId: 88117019,
    name: "TRT On-Treatment Follow-up",
  },
  trt_express: {
    key: "trt_express",
    acuityTypeId: 76832356,
    name: "TRT Express Follow-up",
  },
  ed_initial: {
    key: "ed_initial",
    acuityTypeId: 53224493,
    name: "ED Initial Consultation",
  },
  glp1_initial: {
    key: "glp1_initial",
    acuityTypeId: 80075841,
    name: "GLP-1 Initial Consultation",
  },
  glp1_followup: {
    key: "glp1_followup",
    acuityTypeId: 80576455,
    name: "GLP-1 Follow-up",
  },
  roidcare_initial: {
    key: "roidcare_initial",
    acuityTypeId: 53693767,
    name: "RoidCare+ Initial",
  },
  roidcare_followup: {
    key: "roidcare_followup",
    acuityTypeId: 80478945,
    name: "RoidCare+ Follow-up",
  },
  nutrition_initial: {
    key: "nutrition_initial",
    acuityTypeId: 88945263,
    name: "Nutrition Initial",
  },
  nutrition_followup: {
    key: "nutrition_followup",
    acuityTypeId: 90895435,
    name: "Nutrition Follow-up",
  },
  weightmgmt_initial: {
    key: "weightmgmt_initial",
    acuityTypeId: 90895750,
    name: "Weight Management Initial",
  },
  weightmgmt_followup: {
    key: "weightmgmt_followup",
    acuityTypeId: 90895811,
    name: "Weight Management Follow-up",
  },
};
