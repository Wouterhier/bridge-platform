import { describe, expect, it } from "vitest";
import { shouldEscalate } from "./escalation-guard.js";

describe("shouldEscalate", () => {
  it("escalates medical emergencies", () => {
    expect(shouldEscalate("I have severe chest pain")).toEqual({
      escalate: true,
      reason: "medical_emergency",
    });
    expect(shouldEscalate("I am having thoughts of ending my life")).toEqual({
      escalate: true,
      reason: "medical_emergency",
    });
  });

  it("escalates steroid mentions outside RoidCare", () => {
    expect(shouldEscalate("I want to buy anabolic steroids", "trt_initial")).toEqual({
      escalate: true,
      reason: "ped_mention",
    });
    expect(shouldEscalate("Can you prescribe me SARMs?", "glp1_initial")).toEqual({
      escalate: true,
      reason: "ped_mention",
    });
  });

  it("does not escalate steroid mentions for RoidCare services", () => {
    expect(shouldEscalate("I need help with steroid use", "roidcare_initial")).toEqual({
      escalate: false,
    });
    expect(shouldEscalate("I cycled trenbolone last year", "roidcare_followup")).toEqual({
      escalate: false,
    });
  });

  it("keys RoidCare exception off collected serviceKey, not message wording", () => {
    expect(shouldEscalate("I'm taking steroids", "roidcare_initial")).toEqual({
      escalate: false,
    });
    expect(shouldEscalate("I'm taking steroids", undefined)).toEqual({
      escalate: true,
      reason: "ped_mention",
    });
    expect(shouldEscalate("I'm taking steroids", "trt_initial")).toEqual({
      escalate: true,
      reason: "ped_mention",
    });
  });

  it("does not escalate routine messages", () => {
    expect(shouldEscalate("I want to book a TRT consultation")).toEqual({
      escalate: false,
    });
  });

  it("returns false for undefined or empty message", () => {
    expect(shouldEscalate(undefined)).toEqual({ escalate: false });
    expect(shouldEscalate("")).toEqual({ escalate: false });
    expect(shouldEscalate("   ")).toEqual({ escalate: false });
  });
});
