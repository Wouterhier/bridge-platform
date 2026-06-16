export interface ServiceConfig {
  key: string;
  acuityTypeId: number;
  name: string;
  duration: number;
  price: number;
  calendarId: string | number;
  paid: boolean;
}

export const services: Record<string, ServiceConfig> = {
  free_eligibility: {
    key: "free_eligibility",
    acuityTypeId: 79429909,
    name: "Free Eligibility Consultation",
    duration: 15,
    price: 0,
    calendarId: 12268822,
    paid: false,
  },
  trt_initial: {
    key: "trt_initial",
    acuityTypeId: 53224493,
    name: "TRT Initial Consultation",
    duration: 30,
    price: 179,
    calendarId: "7iQocxTR6z7vykgWNPyw",
    paid: true,
  },
  trt_followup: {
    key: "trt_followup",
    acuityTypeId: 53721340,
    name: "TRT Follow-up",
    duration: 20,
    price: 159,
    calendarId: "zHtlCGvRDmoj9sCLWGeY",
    paid: true,
  },
  trt_ontreatment: {
    key: "trt_ontreatment",
    acuityTypeId: 88117019,
    name: "TRT On-Treatment Follow-up",
    duration: 20,
    price: 159,
    calendarId: "TBTbgHasT90mKkd6e9HU",
    paid: true,
  },
  trt_express: {
    key: "trt_express",
    acuityTypeId: 76832356,
    name: "TRT Express Follow-up",
    duration: 15,
    price: 99,
    calendarId: "dqLVbTJi56p8zACVxODp",
    paid: true,
  },
  ed_initial: {
    key: "ed_initial",
    acuityTypeId: 53224493,
    name: "ED Initial Consultation",
    duration: 30,
    price: 179,
    calendarId: "7iQocxTR6z7vykgWNPyw",
    paid: true,
  },
  glp1_initial: {
    key: "glp1_initial",
    acuityTypeId: 80075841,
    name: "GLP-1 Initial Consultation",
    duration: 20,
    price: 119,
    calendarId: "4vdtC4B6VjJtrHjCLyJi",
    paid: true,
  },
  glp1_followup: {
    key: "glp1_followup",
    acuityTypeId: 80576455,
    name: "GLP-1 Follow-up",
    duration: 15,
    price: 99,
    calendarId: "XwJkvuj7NQw6ufmomFkP",
    paid: true,
  },
  roidcare_initial: {
    key: "roidcare_initial",
    acuityTypeId: 53693767,
    name: "RoidCare+ Initial",
    duration: 30,
    price: 179,
    calendarId: "ZWzPxB1TgBhIZc2QE7lR",
    paid: true,
  },
  roidcare_followup: {
    key: "roidcare_followup",
    acuityTypeId: 80478945,
    name: "RoidCare+ Follow-up",
    duration: 20,
    price: 169,
    calendarId: "DNH4lqU32ug7q3iMi9ov",
    paid: true,
  },
  nutrition_initial: {
    key: "nutrition_initial",
    acuityTypeId: 88945263,
    name: "Nutrition Initial",
    duration: 30,
    price: 159,
    calendarId: "Q3bo64shMDdOe1Uv3cj0",
    paid: true,
  },
  nutrition_followup: {
    key: "nutrition_followup",
    acuityTypeId: 90895435,
    name: "Nutrition Follow-up",
    duration: 20,
    price: 129,
    calendarId: "HBW1ki9DM483Nsps1pmW",
    paid: true,
  },
  weightmgmt_initial: {
    key: "weightmgmt_initial",
    acuityTypeId: 90895750,
    name: "Weight Management Initial",
    duration: 30,
    price: 159,
    calendarId: "8LM6rrDfbhD1Sosyg15n",
    paid: true,
  },
  weightmgmt_followup: {
    key: "weightmgmt_followup",
    acuityTypeId: 90895811,
    name: "Weight Management Follow-up",
    duration: 20,
    price: 129,
    calendarId: "e9wzLcKdcDzs5MAIVtB0",
    paid: true,
  },
};

export function getService(key: string): ServiceConfig | undefined {
  return services[key];
}

export function isPaidService(key: string): boolean {
  return services[key]?.paid ?? true;
}
