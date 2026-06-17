import { describe, expect, it } from "vitest";
import { extract, resolveServiceKey } from "./extract.js";
import { createRouter } from "./model-router-factory.js";
import { loadConfig } from "@romea/model-router";
import type { ScmState } from "./states.js";

function makeRouter(overrides?: Record<string, string>) {
  const cfg = loadConfig();
  return createRouter({
    ...cfg,
    ...(overrides ?? {}),
  } as ReturnType<typeof loadConfig>);
}

const longTimeout = 30000;

describe("extract() real model accuracy", () => {
  it(
    "extracts name from 'My name is John Smith'",
    async () => {
      const hint = await extract(
        "COLLECTING_NAME",
        "My name is John Smith",
        [],
        {},
        { router: makeRouter() },
      );
      expect(hint).toBeTruthy();
      const fullName =
        hint?.fullName ??
        (hint?.firstName && hint?.lastName
          ? `${hint.firstName} ${hint.lastName}`
          : undefined);
      expect(fullName?.toLowerCase()).toBe("john smith");
    },
    longTimeout,
  );

  it(
    "extracts phone from '021 000 0000'",
    async () => {
      const hint = await extract(
        "COLLECTING_PHONE",
        "021 000 0000",
        [],
        {},
        { router: makeRouter() },
      );
      expect(hint?.phone).toMatch(/021\s*000\s*0000/);
    },
    longTimeout,
  );

  it(
    "extracts email from 'andrea@romea.ai'",
    async () => {
      const hint = await extract(
        "COLLECTING_EMAIL",
        "andrea@romea.ai",
        [],
        {},
        { router: makeRouter() },
      );
      expect(hint?.email).toBe("andrea@romea.ai");
    },
    longTimeout,
  );

  it(
    "extracts serviceKey 'trt_initial' from 'I want TRT'",
    async () => {
      const hint = await extract(
        "SELECTING_SERVICE",
        "I want TRT",
        [],
        {},
        { router: makeRouter() },
      );
      expect(hint?.serviceKey).toBe("trt_initial");
    },
    longTimeout,
  );

  it(
    "extracts slotIso from 'The first slot'",
    async () => {
      const slotMenu = [
        { iso: "2026-06-20T09:00:00+12:00" },
        { iso: "2026-06-20T10:00:00+12:00" },
        { iso: "2026-06-20T11:00:00+12:00" },
      ];
      const hint = await extract(
        "AWAITING_SELECTION",
        "The first slot",
        [],
        { slotMenu },
        { router: makeRouter() },
      );
      expect(hint?.slotIso).toBe("2026-06-20T09:00:00+12:00");
    },
    longTimeout,
  );
});

describe("extract() null/escalation states", () => {
  const nullStates: ScmState[] = [
    "NEW",
    "SHOWING_SLOTS",
    "CREATING_CHECKOUT",
    "AWAITING_PAYMENT",
    "BOOKING_ACUITY",
    "CONFIRMED",
  ];

  it.each(nullStates)("returns null for state %s", async (state) => {
    const hint = await extract(state, "hello", [], {}, { router: makeRouter() });
    expect(hint).toBeNull();
  });

  it(
    "returns null for ambiguous input after escalation",
    async () => {
      const hint = await extract(
        "COLLECTING_NAME",
        "hmm maybe",
        [],
        {},
        { router: makeRouter() },
      );
      expect(hint).toBeNull();
    },
    longTimeout,
  );
});

describe("extract() Kimi fallback", () => {
  it(
    "returns parseable JSON when Kimi fallback is used at temperature=1",
    async () => {
      const cfg = loadConfig();
      // Force primary to fail with a broken URL so the router falls back to Kimi.
      const brokenRouter = createRouter({
        ...cfg,
        extractModel: "google/broken-model",
        googleBaseUrl: "http://localhost:1",
      } as ReturnType<typeof loadConfig>);

      const hint = await extract(
        "COLLECTING_NAME",
        "My name is Alice Johnson",
        [],
        {},
        { router: brokenRouter },
      );

      expect(hint).toBeTruthy();
      const fullName =
        hint?.fullName ??
        (hint?.firstName && hint?.lastName
          ? `${hint.firstName} ${hint.lastName}`
          : undefined);
      expect(fullName?.toLowerCase()).toBe("alice johnson");
    },
    longTimeout,
  );
});

// ── New tests for Blocker 1 fixes ───────────────────────────────────────────

describe("resolveServiceKey()", () => {
  it("returns direct key match", () => {
    expect(resolveServiceKey("trt_initial")).toBe("trt_initial");
    expect(resolveServiceKey("free_eligibility")).toBe("free_eligibility");
  });

  it("extracts trt_initial from 'I want TRT initial consultation'", () => {
    expect(resolveServiceKey("I want TRT initial consultation")).toBe("trt_initial");
  });

  it("maps 'Free eligibility check' to free_eligibility", () => {
    expect(resolveServiceKey("Free eligibility check")).toBe("free_eligibility");
    expect(resolveServiceKey("eligibility")).toBe("free_eligibility");
    expect(resolveServiceKey("free eligibility")).toBe("free_eligibility");
  });

  it("maps TRT follow-up variants", () => {
    expect(resolveServiceKey("TRT follow-up")).toBe("trt_followup");
    expect(resolveServiceKey("testosterone follow up")).toBe("trt_followup");
  });

  it("maps TRT on-treatment variants", () => {
    expect(resolveServiceKey("TRT on treatment")).toBe("trt_ontreatment");
    expect(resolveServiceKey("testosterone ongoing")).toBe("trt_ontreatment");
  });

  it("maps ED initial variants", () => {
    expect(resolveServiceKey("ED initial consultation")).toBe("ed_initial");
    expect(resolveServiceKey("erectile dysfunction first visit")).toBe("ed_initial");
  });

  it("maps GLP-1 initial variants", () => {
    expect(resolveServiceKey("GLP-1 initial")).toBe("glp1_initial");
    expect(resolveServiceKey("semaglutide consultation")).toBe("glp1_initial");
  });

  it("maps RoidCare initial variants", () => {
    expect(resolveServiceKey("RoidCare+ initial")).toBe("roidcare_initial");
    expect(resolveServiceKey("sarm initial consultation")).toBe("roidcare_initial");
    expect(resolveServiceKey("steroid follow up")).toBe("roidcare_followup");
  });

  it("maps nutrition variants", () => {
    expect(resolveServiceKey("nutrition initial")).toBe("nutrition_initial");
    expect(resolveServiceKey("nutrition follow-up")).toBe("nutrition_followup");
  });

  it("maps weight management variants", () => {
    expect(resolveServiceKey("weight management initial")).toBe("weightmgmt_initial");
    expect(resolveServiceKey("weight follow up")).toBe("weightmgmt_followup");
  });

  it("rejects vasectomy", () => {
    expect(resolveServiceKey("vasectomy")).toBeNull();
    expect(resolveServiceKey("I want a vasectomy")).toBeNull();
    expect(resolveServiceKey("vasectomy initial")).toBeNull();
  });

  it("returns null for unknown service", () => {
    expect(resolveServiceKey("random gibberish")).toBeNull();
    expect(resolveServiceKey("")).toBeNull();
  });
});

describe("extract() regex fallbacks", () => {
  it("falls back to regex email when model returns empty", async () => {
    const cfg = loadConfig();
    // Force the model to return nothing useful.
    const brokenRouter = createRouter({
      ...cfg,
      extractModel: "google/broken-model",
      extractFallbackModel: "google/broken-model-2",
      googleBaseUrl: "http://localhost:1",
    } as ReturnType<typeof loadConfig>);

    const hint = await extract(
      "COLLECTING_EMAIL",
      "You can reach me at john.doe@romea.ai thanks",
      [],
      {},
      { router: brokenRouter },
    );
    expect(hint?.email).toBe("john.doe@romea.ai");
  }, longTimeout);

  it("falls back to regex phone when model returns empty", async () => {
    const cfg = loadConfig();
    const brokenRouter = createRouter({
      ...cfg,
      extractModel: "google/broken-model",
      extractFallbackModel: "google/broken-model-2",
      googleBaseUrl: "http://localhost:1",
    } as ReturnType<typeof loadConfig>);

    const hint = await extract(
      "COLLECTING_PHONE",
      "My number is +64 21 123 4567",
      [],
      {},
      { router: brokenRouter },
    );
    expect(hint?.phone).toBeTruthy();
    expect(hint?.phone).toMatch(/\+64/);
  }, longTimeout);

  it("falls back to regex name when model returns empty", async () => {
    const cfg = loadConfig();
    const brokenRouter = createRouter({
      ...cfg,
      extractModel: "google/broken-model",
      extractFallbackModel: "google/broken-model-2",
      googleBaseUrl: "http://localhost:1",
    } as ReturnType<typeof loadConfig>);

    const hint = await extract(
      "COLLECTING_NAME",
      "My name is Sarah Connor",
      [],
      {},
      { router: brokenRouter },
    );
    expect(hint).toBeTruthy();
    const fullName =
      hint?.fullName ??
      (hint?.firstName && hint?.lastName
        ? `${hint.firstName} ${hint.lastName}`
        : undefined);
    expect(fullName?.toLowerCase()).toBe("sarah connor");
  }, longTimeout);
});
