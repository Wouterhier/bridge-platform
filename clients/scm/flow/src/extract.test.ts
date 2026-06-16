import { describe, expect, it } from "vitest";
import { extract } from "./extract.js";
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
