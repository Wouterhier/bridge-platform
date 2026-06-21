export type FieldRequirement = "mandatory" | "optional" | "post_booking";
export type FieldType = "date" | "phone" | "email" | "text" | "enum";

export interface FieldSpec {
  id: number;
  key: string;
  label: string;
  requirement: FieldRequirement;
  type: FieldType;
}

export interface AppointmentTypeSpec {
  appointmentTypeId: number;
  fields: FieldSpec[];
}

/**
 * Per-appointment-type field specifications.
 *
 * These are verified against the SelfCareMen Acuity configuration.
 * All consultation types share the same intake form structure (custom field IDs
 * are consistent across types for this account).
 *
 * Base fields (firstName, lastName, email, phone, datetime) are handled
 * separately by the booking code and are NOT listed here.
 */
export const FIELD_SPECS: Record<number, AppointmentTypeSpec> = {
  // Free Eligibility (79429909)
  79429909: {
    appointmentTypeId: 79429909,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // TRT Initial (53224493) — shared with ED Initial
  53224493: {
    appointmentTypeId: 53224493,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // TRT Follow-up (53721340)
  53721340: {
    appointmentTypeId: 53721340,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // TRT On-Treatment (88117019)
  88117019: {
    appointmentTypeId: 88117019,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // TRT Express (76832356)
  76832356: {
    appointmentTypeId: 76832356,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // GLP-1 Initial (80075841)
  80075841: {
    appointmentTypeId: 80075841,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // GLP-1 Follow-up (80576455)
  80576455: {
    appointmentTypeId: 80576455,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // RoidCare+ Initial (53693767)
  53693767: {
    appointmentTypeId: 53693767,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // RoidCare+ Follow-up (80478945)
  80478945: {
    appointmentTypeId: 80478945,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // Nutrition Initial (88945263)
  88945263: {
    appointmentTypeId: 88945263,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // Nutrition Follow-up (90895435)
  90895435: {
    appointmentTypeId: 90895435,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // Weight Management Initial (90895750)
  90895750: {
    appointmentTypeId: 90895750,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
  // Weight Management Follow-up (90895811)
  90895811: {
    appointmentTypeId: 90895811,
    fields: [
      { id: 16762638, key: "dob", label: "date of birth", requirement: "mandatory", type: "date" },
      { id: 16763392, key: "address", label: "address", requirement: "optional", type: "text" },
      { id: 16736084, key: "questions", label: "questions to discuss", requirement: "post_booking", type: "text" },
      { id: 16763393, key: "medications", label: "current medications", requirement: "optional", type: "text" },
      { id: 16763394, key: "medicalHistory", label: "medical history", requirement: "optional", type: "text" },
    ],
  },
};

/**
 * Get the field specification for a given Acuity appointment type.
 * Returns undefined if the type is not known.
 */
export function getFieldSpec(appointmentTypeId: number): AppointmentTypeSpec | undefined {
  return FIELD_SPECS[appointmentTypeId];
}
