// @contract - runs only with REAL_ACUITY_TEST=true env var
// Usage: REAL_ACUITY_TEST=true npx vitest run clients/scm/harness/src/contract/

import { describe, it, expect, beforeAll } from "vitest";
import { createAcuityClient } from "@romea/acuity-client";

const SKIP = !process.env.REAL_ACUITY_TEST;

describe.skipIf(SKIP)("Acuity contract tests (real API)", () => {
  let acuity: ReturnType<typeof createAcuityClient>;

  beforeAll(() => {
    acuity = createAcuityClient({
      userId: process.env.ACUITY_USER_ID!,
      apiKey: process.env.ACUITY_API_KEY!,
    });
  });

  it("lists appointment types", async () => {
    const types = await acuity.getAppointmentTypes();
    expect(Array.isArray(types)).toBe(true);
    expect(types.length).toBeGreaterThan(0);
  });

  it("fetches availability for a known type", async () => {
    const types = await acuity.getAppointmentTypes();
    const type = types[0];
    const date = new Date();
    date.setDate(date.getDate() + 1);
    const dateStr = date.toISOString().split("T")[0];

    const slots = await acuity.getAvailability(type.id, { date: dateStr });
    expect(Array.isArray(slots)).toBe(true);
  });
});
