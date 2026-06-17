import { describe, expect, it } from "vitest";
import {
  validateEmail,
  validateName,
  validatePhone,
  validateService,
  validateSlotSelection,
} from "@romea/scm-flow";

/**
 * Consolidated regression test: all validators.
 *
 * Each validator is tested for:
 * - Valid inputs accepted
 * - Invalid inputs rejected with correct error key
 * - Edge cases from production bugs
 */
describe("validators — consolidated regression", () => {
  describe("validateEmail", () => {
    it("accepts valid email", () => {
      const result = validateEmail("john.smith@selfcaremen.co.nz");
      expect(result.ok).toBe(true);
      expect(result.value).toBe("john.smith@selfcaremen.co.nz");
    });

    it("accepts plus-addressed email", () => {
      const result = validateEmail("jane+clinic@gmail.com");
      expect(result.ok).toBe(true);
      expect(result.value).toBe("jane+clinic@gmail.com");
    });

    it("rejects fabricated domain (example.com)", () => {
      const result = validateEmail("joytests.one@example.com");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("fake_domain");
    });

    it("accepts AI-mutated plus-address as raw patient input", () => {
      // The old bug was the AI mutating andrea@romea.ai into andrea+9@romea.ai.
      // That is prevented at the engine level by running validator against raw message.
      // If patient actually typed this plus-address, it is valid.
      const result = validateEmail("andrea+9@romea.ai");
      expect(result.ok).toBe(true);
      expect(result.value).toBe("andrea+9@romea.ai");
    });

    it("lowercases and trims input", () => {
      const result = validateEmail("  John.Doe@SelfcareMen.co.nz  ");
      expect(result.ok).toBe(true);
      expect(result.value).toBe("john.doe@selfcaremen.co.nz");
    });

    it("rejects missing @", () => {
      const result = validateEmail("notanemail");
      expect(result.ok).toBe(false);
    });

    it("rejects missing domain", () => {
      const result = validateEmail("test@");
      expect(result.ok).toBe(false);
    });
  });

  describe("validatePhone", () => {
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

    it("rejects bare NZ number without country code", () => {
      const result = validatePhone("0210000000");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_country");
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

    it("rejects empty string", () => {
      const result = validatePhone("");
      expect(result.ok).toBe(false);
    });
  });

  describe("validateName", () => {
    it("accepts valid full name", () => {
      const result = validateName("Tom Smith");
      expect(result.ok).toBe(true);
      expect(result.value).toBe("Tom Smith");
    });

    it("rejects placeholder 'Guest Visitor'", () => {
      const result = validateName("Guest Visitor");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("placeholder_name");
    });

    it("rejects placeholder 'Test User'", () => {
      const result = validateName("Test User");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("placeholder_name");
    });

    it("rejects single-word name", () => {
      const result = validateName("Tom");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("first_last_required");
    });

    it("rejects name that looks like an email", () => {
      const result = validateName("tom@example.com");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_name");
    });

    it("rejects empty string", () => {
      const result = validateName("");
      expect(result.ok).toBe(false);
    });
  });

  describe("validateService", () => {
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

    it("rejects deactivated vasectomy service", () => {
      const result = validateService("vasectomy");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("service_unavailable");
    });

    it("rejects vasectomy_initial variant", () => {
      const result = validateService("vasectomy_initial");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("service_unavailable");
    });

    it("rejects unknown service key", () => {
      const result = validateService("unknown_service");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("unknown_service");
    });

    it("rejects empty string", () => {
      const result = validateService("");
      expect(result.ok).toBe(false);
    });
  });

  describe("validateSlotSelection", () => {
    const slotMenu = [
      { iso: "2026-06-20T09:00:00+12:00" },
      { iso: "2026-06-20T10:00:00+12:00" },
    ];

    it("accepts a slot from the presented menu", () => {
      const result = validateSlotSelection("2026-06-20T09:00:00+12:00", slotMenu);
      expect(result.ok).toBe(true);
      expect(result.value).toBe("2026-06-20T09:00:00+12:00");
    });

    it("rejects a slot not in the menu", () => {
      const result = validateSlotSelection("2026-06-21T09:00:00+12:00", slotMenu);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_slot");
    });

    it("rejects empty slot string", () => {
      const result = validateSlotSelection("", slotMenu);
      expect(result.ok).toBe(false);
    });

    it("rejects slot when menu is empty", () => {
      const result = validateSlotSelection("2026-06-20T09:00:00+12:00", []);
      expect(result.ok).toBe(false);
    });
  });
});
