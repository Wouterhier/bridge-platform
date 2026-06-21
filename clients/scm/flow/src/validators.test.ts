import { describe, expect, it } from "vitest";
import {
  validateEmail,
  validateName,
  validatePhone,
  validateService,
  validateSlotSelection,
  normalizeDob,
} from "./validators.js";

describe("validateEmail", () => {
  it("rejects fabricated joytests.one@example.com", () => {
    const result = validateEmail("joytests.one@example.com");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fake_domain");
  });

  it("accepts plus-addressed jane+clinic@gmail.com", () => {
    const result = validateEmail("jane+clinic@gmail.com");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("jane+clinic@gmail.com");
  });

  it("accepts raw patient input andrea+9@romea.ai (format is valid, domain is not blocked)", () => {
    // The old bug was the AI mutating andrea@romea.ai into andrea+9@romea.ai.
    // That is now prevented at the engine/state-machine level by running the
    // validator against the patient's raw message. If the patient actually
    // typed this plus-address, it is a valid email.
    const result = validateEmail("andrea+9@romea.ai");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("andrea+9@romea.ai");
  });

  it("accepts valid email", () => {
    const result = validateEmail("Andrea.Smith@romea.ai");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("andrea.smith@romea.ai");
  });

  it("stores exactly what the patient typed, lowercased and trimmed only", () => {
    const result = validateEmail("  John.Doe@SelfcareMen.co.nz  ");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("john.doe@selfcaremen.co.nz");
  });
});

describe("validatePhone", () => {
  it("accepts bare NZ mobile 0210000000 (assumes +64)", () => {
    const result = validatePhone("0210000000");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("+64210000000");
  });

  it("accepts bare NZ landline 093000000 (assumes +64)", () => {
    const result = validatePhone("093000000");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("+6493000000");
  });

  it("rejects too short number", () => {
    const result = validatePhone("123");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("too_short");
  });

  it("rejects invalid characters", () => {
    const result = validatePhone("+64abc12345");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_chars");
  });

  it("accepts +64 format", () => {
    const result = validatePhone("+64 21 000 0000");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("+64210000000");
  });

  it("accepts 0064 format", () => {
    const result = validatePhone("0064 21 000 0000");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("+64210000000");
  });

  it("accepts international number with explicit prefix", () => {
    const result = validatePhone("+61 412 345 678");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("+61412345678");
  });
});

describe("validateName", () => {
  it("rejects placeholder name Guest Visitor", () => {
    const result = validateName("Guest Visitor");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("placeholder_name");
  });

  it("rejects single-word name Tom", () => {
    const result = validateName("Tom");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("first_last_required");
  });

  it("rejects Test User", () => {
    const result = validateName("Test User");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("placeholder_name");
  });

  it("rejects name that looks like an email", () => {
    const result = validateName("tom@example.com");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_name");
  });

  it("accepts valid full name", () => {
    const result = validateName("Tom Smith");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("Tom Smith");
  });
});

describe("validateService", () => {
  it("rejects deactivated vasectomy service", () => {
    const result = validateService("vasectomy");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("service_unavailable");
  });

  it("rejects vasectomy_initial", () => {
    const result = validateService("vasectomy_initial");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("service_unavailable");
  });

  it("accepts free eligibility service", () => {
    const result = validateService("free_eligibility");
    expect(result.ok).toBe(true);
    expect(result.value?.paid).toBe(false);
  });

  it("accepts paid trt_initial service", () => {
    const result = validateService("trt_initial");
    expect(result.ok).toBe(true);
    expect(result.value?.paid).toBe(true);
  });
});

describe("validateSlotSelection", () => {
  it("accepts a slot from the presented menu", () => {
    const result = validateSlotSelection("2026-06-20T09:00:00+12:00", [
      { iso: "2026-06-20T09:00:00+12:00" },
      { iso: "2026-06-20T10:00:00+12:00" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("2026-06-20T09:00:00+12:00");
  });

  it("rejects a slot not in the menu", () => {
    const result = validateSlotSelection("2026-06-21T09:00:00+12:00", [
      { iso: "2026-06-20T09:00:00+12:00" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_slot");
  });
});

describe("normalizeDob", () => {
  it("normalizes DD/MM/YYYY with day > 12 (unambiguous)", () => {
    const result = normalizeDob("26/7/1995");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("07/26/1995");
  });

  it("normalizes ISO YYYY-MM-DD", () => {
    const result = normalizeDob("1995-07-26");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("07/26/1995");
  });

  it("normalizes 'July 26 1995'", () => {
    const result = normalizeDob("July 26 1995");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("07/26/1995");
  });

  it("normalizes '26 Jul 1995'", () => {
    const result = normalizeDob("26 Jul 1995");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("07/26/1995");
  });

  it("normalizes DD.MM.YYYY", () => {
    const result = normalizeDob("26.07.1995");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("07/26/1995");
  });

  it("flags ambiguous 09/06/1990", () => {
    const result = normalizeDob("09/06/1990");
    expect(result.ok).toBe(false);
    const ambigResult = result as { ok: false; ambiguous: true; hint: string };
    expect(ambigResult.ambiguous).toBe(true);
    expect(ambigResult.hint).toContain("June");
    expect(ambigResult.hint).toContain("September");
  });

  it("rejects impossible date 31/02/1990", () => {
    const result = normalizeDob("31/02/1990");
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toBe("invalid_day");
    }
  });

  it("rejects too young (age < 16)", () => {
    const result = normalizeDob("01/01/2020");
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toBe("too_young");
    }
  });

  it("rejects implausible age (> 120)", () => {
    const result = normalizeDob("01/01/1800");
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toBe("implausible_age");
    }
  });
});

describe("accepts valid inputs", () => {
  it("accepts valid email/phone/name/service/slot", () => {
    expect(validateEmail("john.smith@selfcaremen.co.nz").ok).toBe(true);
    expect(validatePhone("+64 21 000 0000").ok).toBe(true);
    expect(validateName("John Smith").ok).toBe(true);
    expect(validateService("trt_initial").ok).toBe(true);
    expect(
      validateSlotSelection("2026-06-20T09:00:00+12:00", [
        { iso: "2026-06-20T09:00:00+12:00" },
      ]).ok,
    ).toBe(true);
  });
});
