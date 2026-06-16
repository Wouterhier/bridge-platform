import type { Db, PaymentSessionRow } from "./types.js";

export async function findPaymentSessionByIdempotencyKey(
  db: Db,
  key: string,
): Promise<PaymentSessionRow | null> {
  const result = await db.query<PaymentSessionRow>(
    `SELECT * FROM payment_sessions WHERE idempotency_key = $1 LIMIT 1`,
    [key],
  );
  return result.rows[0] ?? null;
}

export async function markAppointmentCreated(
  db: Db,
  paymentSessionId: string,
  acuityAppointmentId: string | number,
): Promise<void> {
  await db.query(
    `UPDATE payment_sessions
     SET acuity_appointment_id = $1, updated_at = now()
     WHERE id = $2`,
    [String(acuityAppointmentId), paymentSessionId],
  );
}
