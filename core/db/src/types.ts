export interface Db {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PaymentSessionRow {
  id: string;
  stripe_session_id: string;
  status: string;
  slot_iso: Date;
  appointment_type_id: string;
  contact_id: string;
  conversation_id: string | null;
  idempotency_key: string | null;
  collected_fields: Record<string, unknown>;
  acuity_appointment_id?: string | null;
  paid_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}
