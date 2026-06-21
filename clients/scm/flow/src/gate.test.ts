import { describe, expect, it } from "vitest";
import { gateApiCall, buildValidatedPayload } from "./gate.js";

describe("gateApiCall", () => {
  it("blocks on missing dob and phone when only name+email given", () => {
    const result = gateApiCall(79429909, {
      fullName: "John Smith",
      email: "j@x.com",
      // phone and dob intentionally absent
    });
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.missing.some((f) => f.key === "dob")).toBe(true);
      expect(result.missing.some((f) => f.key === "phone")).toBe(true);
    }
  });

  it("blocks on missing phone even if email present", () => {
    const result = gateApiCall(79429909, {
      fullName: "John Smith",
      email: "j@x.com",
      dob: "07/26/1995",
      // phone intentionally absent
    });
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.missing.some((f) => f.key === "phone")).toBe(true);
    }
  });

  it("blocks on missing fullName", () => {
    const result = gateApiCall(79429909, {
      phone: "+64210000000",
      email: "j@x.com",
      dob: "07/26/1995",
    });
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.missing.some((f) => f.key === "fullName")).toBe(true);
    }
  });

  it("allows valid dob in any format and normalizes it", () => {
    const result = gateApiCall(79429909, {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "j@x.com",
      dob: "26/7/1995",
    });
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.payload.dob).toBe("07/26/1995");
    }
  });

  it("passes when all mandatory fields are present", () => {
    const result = gateApiCall(79429909, {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "j@x.com",
      dob: "07/26/1995",
    });
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.payload.fullName).toBe("John Smith");
      expect(result.payload.phone).toBe("+64210000000");
      expect(result.payload.email).toBe("j@x.com");
      expect(result.payload.dob).toBe("07/26/1995");
    }
  });

  it("includes optional fields when present", () => {
    const result = gateApiCall(79429909, {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "j@x.com",
      dob: "07/26/1995",
      address: "123 Main St",
      medications: "None",
    });
    expect(result.ready).toBe(true);
    if (result.ready) {
      expect(result.payload.address).toBe("123 Main St");
      expect(result.payload.medications).toBe("None");
    }
  });

  it("excludes post_booking fields from gate", () => {
    const result = gateApiCall(79429909, {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "j@x.com",
      dob: "07/26/1995",
    });
    expect(result.ready).toBe(true);
    if (result.ready) {
      // questions is post_booking — should not be required
      expect(result.payload.questions).toBeUndefined();
    }
  });

  it("returns safe default when appointment type is unknown", () => {
    const result = gateApiCall(99999999, {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "j@x.com",
      dob: "07/26/1995",
    });
    // Unknown type → no custom mandatory fields, but base fields still checked
    expect(result.ready).toBe(true);
  });
});

describe("buildValidatedPayload", () => {
  it("normalizes NZ phone without prefix", () => {
    const payload = buildValidatedPayload(79429909, {
      fullName: "John Smith",
      phone: "0211234567",
      email: "j@x.com",
      dob: "26/7/1995",
    });
    expect(payload.phone).toBe("+64211234567");
    expect(payload.dob).toBe("07/26/1995");
  });

  it("omits absent optional fields", () => {
    const payload = buildValidatedPayload(79429909, {
      fullName: "John Smith",
      phone: "+64210000000",
      email: "j@x.com",
      dob: "07/26/1995",
    });
    expect(payload.address).toBeUndefined();
    expect(payload.medications).toBeUndefined();
    expect(payload.medicalHistory).toBeUndefined();
  });
});
