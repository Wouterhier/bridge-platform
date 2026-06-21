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

  it("retries on HTML response and returns empty array for availability", async () => {
    const client = createAcuityClient({ userId, apiKey });
    let callCount = 0;
    mockFetch((input) => {
      const url = getUrl(input);
      expect(url).toContain("/availability/times");
      callCount++;
      if (callCount < 3) {
        return new Response(
          "<!DOCTYPE html><html><body>Gateway Error</body></html>",
          {
            status: 502,
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      return new Response(JSON.stringify([{ time: "2026-06-20T10:00:00" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await client.getAvailability(79429909, { date: "2026-06-20" });
    expect(callCount).toBe(3);
    expect(result).toEqual([{ time: "2026-06-20T10:00:00" }]);
  });

  it("returns empty array for availability when HTML persists after retries", async () => {
    const client = createAcuityClient({ userId, apiKey });
    let callCount = 0;
    mockFetch((input) => {
      const url = getUrl(input);
      expect(url).toContain("/availability/times");
      callCount++;
      return new Response(
        "<!DOCTYPE html><html><body>Maintenance</body></html>",
        {
          status: 503,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    });
    const result = await client.getAvailability(79429909, { date: "2026-06-20" });
    expect(callCount).toBe(3);
    expect(result).toEqual([]);
  });

  it("prevents double-book race via in-flight deduplication", async () => {
    const rows: Array<Partial<import("@romea/bridge-db").PaymentSessionRow>> = [
      {
        id: "ps_race",
        idempotency_key: "race-test-123",
        status: "paid",
        acuity_appointment_id: null,
      },
    ];
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const db: Db = {
      async query<T = unknown>(sql: string, params?: unknown[]) {
        if (sql.toLowerCase().includes("select")) {
          const key = params?.[0] as string | undefined;
          const matched = rows.find((r) => r.idempotency_key === key);
          return { rows: matched ? [matched as T] : [] };
        }
        if (sql.toLowerCase().includes("update")) {
          updates.push({ sql, params: params ?? [] });
          const acuityId = params?.[0] as string;
          const sessionId = params?.[1] as string;
          const row = rows.find((r) => r.id === sessionId);
          if (row) row.acuity_appointment_id = acuityId;
        }
        return { rows: [] };
      },
    };

    const client = createAcuityClient({ userId, apiKey, db });
    let postCount = 0;
    mockFetch((input, init) => {
      const url = getUrl(input);
      if (url.includes("/appointments") && init?.method === "POST") {
        postCount++;
        // Simulate slight delay so second concurrent call hits in-flight lock.
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve(new Response(JSON.stringify({ id: "appt-1" }), { status: 201 }));
          }, 50);
        });
      }
      return new Response(JSON.stringify({ id: "appt-2" }), { status: 201 });
    });

    const [result1, result2] = await Promise.all([
      client.createAppointment({
        appointmentTypeID: 79429909,
        datetime: "2026-06-20T10:00:00",
        idempotencyKey: "race-test-123",
        paymentSessionId: "ps_race",
      }),
      client.createAppointment({
        appointmentTypeID: 79429909,
        datetime: "2026-06-20T10:00:00",
        idempotencyKey: "race-test-123",
        paymentSessionId: "ps_race",
      }),
    ]);

    expect(postCount).toBe(1);
    expect(result1).toEqual({ id: "appt-1" });
    expect(result2).toEqual({ id: "appt-1" });

    const updatedRow = rows.find((r) => r.id === "ps_race");
    expect(updatedRow?.acuity_appointment_id).toBe("appt-1");
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

  it("does NOT default missing optional nutrition fields", () => {
    const fields = mapIntakeFields("nutrition_initial", {
      firstName: "John",
      lastName: "Doe",
      dob: "15/05/1990",
      address: "123 Main St",
    });
    const byId = Object.fromEntries(fields.map((f) => [f.id, f.value]));
    // height, weight, allergies, medicalConditions, referralSource are optional
    // and should be OMITTED when absent — never defaulted.
    expect(byId[16934759]).toBeUndefined();
    expect(byId[16934760]).toBeUndefined();
    expect(byId[18227676]).toBeUndefined();
  });

  it("does NOT default missing dob to 01/01/1990", () => {
    const fields = mapIntakeFields("free_eligibility", {
      firstName: "John",
      lastName: "Doe",
      // dob intentionally absent
      address: "123 Main St",
    });
    const byId = Object.fromEntries(fields.map((f) => [f.id, f.value]));
    expect(byId[16762638]).toBeUndefined();
  });

  it("throws on unknown service key", () => {
    expect(() => mapIntakeFields("unknown_service", {})).toThrow("Unknown service key");
  });
});
