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

interface UnsentReplyRow {
  message_id: string;
  contact_id: string;
  send_payload: SendPayload;
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
 * GHL SMS/chat message sends are idempotent enough for at-least-once:
 * sending the same text twice is acceptable (the patient may see a
 * duplicate, which is better than a silent drop).  If a row already
 * has `sent_at` set we never re-send it.
 */
export async function recoverUnsentReplies(
  db: Db,
  sendMessage: (locationId: string, contactId: string, payload: { message: string; channel: string }) => Promise<unknown>,
): Promise<void> {
  const result = await db.query<UnsentReplyRow>(
    `SELECT message_id, contact_id, send_payload, send_attempts
     FROM processed_messages
     WHERE sent_at IS NULL
       AND send_attempts < $1
     ORDER BY processed_at ASC`,
    [MAX_SEND_ATTEMPTS],
  );

  if (result.rows.length === 0) return;

  console.log(`[recoverUnsentReplies] found ${result.rows.length} unsent reply(s)`);

  for (const row of result.rows) {
    try {
      const { locationId, ...payload } = row.send_payload;
      await sendMessage(locationId, row.contact_id, payload);
      await markMessageSent(db, row.message_id);
      console.log(`[recoverUnsentReplies] resent ${row.message_id}`);
    } catch (err) {
      await incrementSendAttempts(db, row.message_id);
      console.error(`[recoverUnsentReplies] failed to resend ${row.message_id}:`, err);
    }
  }
}
