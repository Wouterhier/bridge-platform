import type { Db } from "./types.js";

/* ------------------------------------------------------------------ */
/*  Shared message-recovery helpers for at-least-once delivery          */
/*  Used by both conversation-service and payment-service.              */
/* ------------------------------------------------------------------ */

export interface SendPayload {
  message: string;
  channel: string;
  locationId: string;
}

interface RecoveryRow {
  message_id: string;
  contact_id: string;
  send_payload: SendPayload | null;
  raw_inbound: unknown | null;
  send_attempts: number;
}

const MAX_SEND_ATTEMPTS = 5;

export async function markMessageProcessed(
  db: Db,
  messageId: string,
  contactId: string,
  sendPayload: SendPayload,
): Promise<void> {
  await db.query(
    `INSERT INTO processed_messages (message_id, contact_id, sent_at, send_payload, send_attempts)
     VALUES ($1, $2, NULL, $3, 0)
     ON CONFLICT (message_id) DO UPDATE SET
       send_payload = EXCLUDED.send_payload,
       contact_id = EXCLUDED.contact_id`,
    [messageId, contactId, JSON.stringify(sendPayload)],
  );
}

export async function markMessageSent(
  db: Db,
  messageId: string,
): Promise<void> {
  await db.query(
    `UPDATE processed_messages
     SET sent_at = now(),
         send_attempts = send_attempts + 1
     WHERE message_id = $1`,
    [messageId],
  );
}

export async function incrementSendAttempts(
  db: Db,
  messageId: string,
): Promise<void> {
  await db.query(
    `UPDATE processed_messages
     SET send_attempts = send_attempts + 1
     WHERE message_id = $1`,
    [messageId],
  );
}

/**
 * Recover unsent replies on startup.
 *
 * Three-state recovery:
 *   State A: received, not yet processed (send_payload IS NULL AND send_attempts = 0)
 *            → re-process from scratch using raw_inbound
 *   State B: processed, reply generated, not sent (send_payload IS NOT NULL AND sent_at IS NULL)
 *            → re-send the stored reply
 *   State C: sent (sent_at IS NOT NULL)
 *            → done, do nothing
 *
 * GHL SMS/chat message sends are idempotent enough for at-least-once:
 * sending the same text twice is acceptable (the patient may see a
 * duplicate, which is better than a silent drop).
 */
export async function recoverUnsentReplies(
  db: Db,
  sendMessage: (locationId: string, contactId: string, payload: { message: string; channel: string }) => Promise<unknown>,
  reprocessInbound?: (rawPayload: unknown) => Promise<unknown>,
): Promise<void> {
  const result = await db.query<RecoveryRow>(
    `SELECT message_id, contact_id, send_payload, raw_inbound, send_attempts
     FROM processed_messages
     WHERE sent_at IS NULL
       AND send_attempts < $1
     ORDER BY processed_at ASC`,
    [MAX_SEND_ATTEMPTS],
  );

  if (result.rows.length === 0) return;

  process.stdout.write(`[recoverUnsentReplies] found ${result.rows.length} unsent reply(s)\n`);

  for (const row of result.rows) {
    try {
      if (row.send_payload !== null) {
        // State B: reply generated but not sent - re-send
        const { locationId, ...payload } = row.send_payload;
        await sendMessage(locationId, row.contact_id, payload);
        await markMessageSent(db, row.message_id);
        process.stdout.write(`[recoverUnsentReplies] resent reply for ${row.message_id}\n`);
      } else if (row.raw_inbound !== null && reprocessInbound) {
        // State A: received but never processed - re-process from scratch
        // Delete the placeholder row first so processing can re-insert cleanly
        await db.query('DELETE FROM processed_messages WHERE message_id = $1', [row.message_id]);
        process.stdout.write(`[recoverUnsentReplies] re-processing ${row.message_id} (never processed)\n`);
        await reprocessInbound(row.raw_inbound);
      } else {
        // No send_payload AND no raw_inbound AND no reprocessInbound - log and leave
        process.stderr.write(`[recoverUnsentReplies] cannot recover ${row.message_id}: no send_payload, no raw_inbound\n`);
      }
    } catch (err) {
      await incrementSendAttempts(db, row.message_id);
      process.stderr.write(`[recoverUnsentReplies] failed to recover ${row.message_id}: ${String(err)}\n`);
    }
  }
}
