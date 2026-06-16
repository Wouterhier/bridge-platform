import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createAcuityClient, mapIntakeFields, type AcuityAppointment } from "./acuity-client.js";
import type { Db } from "@romea/bridge-db";

function mockFetch(handler: (input: RequestInfo, init?: RequestInit) => Response | Promise<Response>) {
  const stub = vi.fn(async (input: RequestInfo, init?: RequestInit) => handler(input, init));
  vi.stubGlobal("fetch", stub);
  return stub;
}

function getUrl(input: RequestInfo): string {
  return typeof input === "string" ? input : input.url;
}

function makeDb(rows: Array<Partial<import("@romea/bridge-db").PaymentSessionRow>> = []): Db {
  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const key = params?.[0] as string | undefined;
      const matched = rows.find((r) => r.idempotency_key === key);
      return { rows: matched ? [matched as T] : [] };
    },
  };
}

describe("acuity-client", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const userId = "user_123";
  const apiKey = "key_456";

  it("getAppointmentTypes returns list", async () => {
    const client = createAcuityClient({ userId, apiKey });
    mockFetch(() => new Response(JSON.stringify([{ id: 1, name: "Consultation" }]), { status: 200 }));
    const result = await client.getAppointmentTypes();
    expect(result).toHaveLength(1);
  });

  it("getAvailability returns slots", async () => {
    const client = createAcuityClient({ userId, apiKey });
    mockFetch((input) => {
      const url = getUrl(input);
      expect(url).toContain("/availability/times");
      expect(url).toContain("appointmentTypeID=79429909");
      return new Response(JSON.stringify([{ time: "2026-06-20T10:00:00" }]), { status: 200 });
    });
    const result = await client.getAvailability(79429909, { date: "2026-06-20" });
    expect(result).toEqual([{ time: "2026-06-20T10:00:00" }]);
  });

  it("createAppointment posts and returns appointment", async () => {
    const client = createAcuityClient({ userId, apiKey });
    const appointment: AcuityAppointment = { id: 123, firstName: "John" };
    mockFetch((input, init) => {
      expect(getUrl(input)).toContain("/appointments");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(appointment), { status: 201 });
    });
    const result = await client.createAppointment({
      appointmentTypeID: 79429909,
      datetime: "2026-06-20T10:00:00",
    });
    expect(result).toEqual(appointment);
  });

  it("createAppointment prevents double-book via payment_sessions", async () => {
    const db = makeDb([
      {
        id: "ps_1",
        idempotency_key: "key_abc",
        acuity_appointment_id: "456",
      },
    ]);
    const client = createAcuityClient({ userId, apiKey, db });
    const existing: AcuityAppointment = { id: 456, firstName: "Jane" };
    let postCalled = false;
    mockFetch((input, init) => {
      const url = getUrl(input);
      if (url.includes("/appointments/456")) {
        return new Response(JSON.stringify(existing), { status: 200 });
      }
      if (url.includes("/appointments") && init?.method === "POST") {
        postCalled = true;
      }
      return new Response(JSON.stringify({ id: 999 }), { status: 201 });
    });

    const result = await client.createAppointment({
      appointmentTypeID: 79429909,
      datetime: "2026-06-20T10:00:00",
      idempotencyKey: "key_abc",
    });
    expect(result).toEqual(existing);
    expect(postCalled).toBe(false);
  });

  it("createAppointment stores acuity_appointment_id after creation", async () => {
    const updates: Array<{ id: string; acuityId: string }> = [];
    const db: Db = {
      async query<T = unknown>(sql: string, params?: unknown[]) {
        if (sql.toLowerCase().includes("update")) {
          updates.push({ id: params?.[1] as string, acuityId: params?.[0] as string });
        }
        return { rows: [] };
      },
    };
    const client = createAcuityClient({ userId, apiKey, db });
    const appointment: AcuityAppointment = { id: 789, firstName: "John" };
    mockFetch(() => new Response(JSON.stringify(appointment), { status: 201 }));

    await client.createAppointment({
      appointmentTypeID: 79429909,
      datetime: "2026-06-20T10:00:00",
      idempotencyKey: "key_xyz",
      paymentSessionId: "ps_2",
    });
    expect(updates).toEqual([{ id: "ps_2", acuityId: "789" }]);
  });

  it("getAppointment returns appointment", async () => {
    const client = createAcuityClient({ userId, apiKey });
    const appointment: AcuityAppointment = { id: 123, firstName: "John" };
    mockFetch((input) => {
      expect(getUrl(input)).toContain("/appointments/123");
      return new Response(JSON.stringify(appointment), { status: 200 });
    });
    const result = await client.getAppointment(123);
    expect(result).toEqual(appointment);
  });

  it("updateAppointmentFormFields returns updated appointment", async () => {
    const client = createAcuityClient({ userId, apiKey });
    const appointment: AcuityAppointment = { id: 123, forms: [{ id: 1, values: [{ id: 1, value: "yes" }] }] };
    mockFetch((input, init) => {
      expect(getUrl(input)).toContain("/appointments/123");
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify(appointment), { status: 200 });
    });
    const result = await client.updateAppointmentFormFields(123, [{ id: 1, value: "yes" }]);
    expect(result).toEqual(appointment);
  });
});

describe("mapIntakeFields", () => {
  it("maps free eligibility fields", () => {
    const fields = mapIntakeFields("free_eligibility", {
      firstName: "John",
      lastName: "Doe",
      dob: "15/05/1990",
      address: "123 Main St",
      consultationType: "Free Eligibility",
    });
    const ids = fields.map((f) => f.id);
    expect(ids).toContain(16440628);
    expect(ids).toContain(16762638);
    expect(ids).toContain(16736078);
  });

  it("maps TRT initial fields", () => {
    const fields = mapIntakeFields("trt_initial", {
      firstName: "John",
      lastName: "Doe",
      dob: "15/05/1990",
      address: "123 Main St",
      gpName: "Dr Smith",
      currentMedications: "None",
    });
    expect(fields).toHaveLength(7);
    const fieldIds = fields.map((f) => f.id);
    expect(fieldIds).toContain(13992148);
    expect(fieldIds).toContain(14056070);
  });

  it("maps nutrition fields with defaults", () => {
    const fields = mapIntakeFields("nutrition_initial", {
      firstName: "John",
      lastName: "Doe",
      dob: "15/05/1990",
      address: "123 Main St",
    });
    const byId = Object.fromEntries(fields.map((f) => [f.id, f.value]));
    expect(byId[16934759]).toBe("175");
    expect(byId[16934760]).toBe("75");
    expect(byId[18227676]).toBe("Chat");
  });

  it("throws on unknown service key", () => {
    expect(() => mapIntakeFields("unknown_service", {})).toThrow("Unknown service key");
  });
});
