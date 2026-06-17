import { Pool } from "pg";
import type { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import { generate } from "@romea/scm-flow";
import type { ScmCollected } from "@romea/scm-flow";
import type { ModelRouter } from "@romea/model-router";
import { mapIntakeFields } from "@romea/acuity-client";
import { markMessageProcessed, markMessageSent } from "@romea/bridge-db";
import Stripe from "stripe";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PaymentProcessorDeps {
  db: Pool;
  ghl: ReturnType<typeof createGhlClient>;
  acuity: ReturnType<typeof createAcuityClient>;
  stripe: ReturnType<typeof createStripeClient>;
  router: ModelRouter;
  ghlPipelineId: string;
  ghlLocationId: string;
}

export interface PaymentResult {
  appointmentId: string | number;
  messageSent: boolean;
}

interface PaymentSessionRow {
  id: string;
  stripe_session_id: string;
  status: string;
  slot_iso: string;
  appointment_type_id: string;
  contact_id: string;
  conversation_id: string | null;
  idempotency_key: string | null;
  collected_fields: Record<string, unknown>;
  acuity_appointment_id: string | null;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STAGE_INITIAL_CONSULTATION_SCHEDULED =
  "750a6c84-d60f-424a-ac88-876d06fa362d";

/* ------------------------------------------------------------------ */
/*  Idempotent payment completion                                      */
/* ------------------------------------------------------------------ */

export async function onPaymentConfirmed(
  session: Stripe.Checkout.Session,
  deps: PaymentProcessorDeps,
): Promise<PaymentResult> {
  const { db, ghl, acuity, router, ghlPipelineId, ghlLocationId } = deps;

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    /* 2. SELECT payment_sessions FOR UPDATE */
    const psResult = await client.query<PaymentSessionRow>(
      `SELECT * FROM payment_sessions WHERE stripe_session_id = $1 FOR UPDATE`,
      [session.id],
    );

    let paymentSession = psResult.rows[0];

    /* If not found, create from session metadata */
    if (!paymentSession) {
      const metadata = session.metadata ?? {};
      const inserted = await client.query<PaymentSessionRow>(
        `INSERT INTO payment_sessions
         (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          session.id,
          "pending",
          metadata.slot_iso ?? new Date().toISOString(),
          metadata.appointment_type_id ?? "0",
          metadata.contact_id ?? "",
          metadata.conversation_id ?? null,
          metadata.idempotency_key ?? `webhook-${session.id}`,
          JSON.stringify(metadata),
        ],
      );
      paymentSession = inserted.rows[0];
    }

    /* Idempotency: already paid with appointment created */
    if (
      paymentSession.status === "paid" &&
      paymentSession.acuity_appointment_id
    ) {
      await client.query("COMMIT");
      return {
        appointmentId: paymentSession.acuity_appointment_id,
        messageSent: false,
      };
    }

    /* 3. UPDATE status = 'paid' */
    await client.query(
      `UPDATE payment_sessions
       SET status = 'paid', paid_at = now(), updated_at = now()
       WHERE id = $1`,
      [paymentSession.id],
    );

    /* 4. Create Acuity appointment */
    const collected = paymentSession.collected_fields as ScmCollected;
    const fullName = collected.fullName ?? "";
    const [firstName, ...lastNameParts] = fullName.split(" ");
    const lastName = lastNameParts.join(" ");

    const appointment = await acuity.createAppointment({
      appointmentTypeID: Number(paymentSession.appointment_type_id),
      datetime: paymentSession.slot_iso,
      firstName,
      lastName,
      email:
        (collected.email as string) ?? session.customer_email ?? "",
      phone: collected.phone as string | undefined,
      fields: mapIntakeFields(
        (collected.serviceKey as string) ?? "",
        {
          firstName,
          lastName,
          patientName: fullName,
          email: collected.email as string,
          phone: collected.phone as string,
        },
      ),
      idempotencyKey:
        paymentSession.idempotency_key ??
        `scm-booking-${paymentSession.conversation_id}-${paymentSession.slot_iso}`,
      paymentSessionId: paymentSession.id,
    });

    /* 5. UPDATE acuity_appointment_id */
    await client.query(
      `UPDATE payment_sessions
       SET acuity_appointment_id = $1, updated_at = now()
       WHERE id = $2`,
      [String(appointment.id), paymentSession.id],
    );

    /* 6. UPDATE conversations state */
    if (paymentSession.conversation_id) {
      await client.query(
        `UPDATE conversations
         SET current_state = 'BOOKING_ACUITY',
             collected_fields = collected_fields || $1::jsonb,
             updated_at = now()
         WHERE id = $2`,
        [
          JSON.stringify({
            _acuityAppointmentId: String(appointment.id),
            _stripeSessionId: session.id,
          }),
          paymentSession.conversation_id,
        ],
      );

      await client.query(
        `UPDATE conversations
         SET current_state = 'CONFIRMED', updated_at = now()
         WHERE id = $1`,
        [paymentSession.conversation_id],
      );
    }

    /* 7. Generate confirmation message */
    let replyText: string;
    try {
      replyText = await generate(
        "CONFIRMED",
        collected,
        [],
        undefined,
        undefined,
        { router },
      );
    } catch {
      replyText =
        "Your appointment is confirmed. If you need to reschedule or have any questions, just let us know.";
    }

    /* 8. Record processed_messages BEFORE sending (inside tx).
          sent_at is left NULL so recoverUnsentReplies() can retry
          if the process crashes before the actual send. */
    const confirmMessageId = `scm-confirm-${paymentSession.id}`;
    await markMessageProcessed(client, confirmMessageId, paymentSession.contact_id, {
      message: replyText,
      channel: "sms",
      locationId: ghlLocationId,
    });

    /* 9. Commit transaction */
    await client.query("COMMIT");

    /* 10. Send confirmation via GHL (outside tx) */
    let messageSent = false;
    try {
      await ghl.sendMessage(ghlLocationId, paymentSession.contact_id, {
        message: replyText,
        channel: "sms",
      });
      messageSent = true;
      await markMessageSent(db, confirmMessageId);
    } catch (err) {
      console.error("[payment-processor] GHL send failed:", err);
      /* sent_at stays NULL — recoverUnsentReplies will retry on restart */
    }

    /* 11. Update GHL opportunity stage and tags (outside transaction) */
    try {
      const opportunities = await ghl.getPipelineOpportunities(
        ghlLocationId,
        paymentSession.contact_id,
        ghlPipelineId,
      );

      if (opportunities.length > 0) {
        const opp = opportunities[0];
        await ghl.updateOpportunityStageSafe(
          ghlLocationId,
          opp.id,
          STAGE_INITIAL_CONSULTATION_SCHEDULED,
          opp.pipelineStageId,
        );
      } else {
        await ghl.createOpportunity(ghlLocationId, {
          pipelineId: ghlPipelineId,
          pipelineStageId: STAGE_INITIAL_CONSULTATION_SCHEDULED,
          locationId: ghlLocationId,
          contactId: paymentSession.contact_id,
          status: "open",
        });
      }

      /* Add tags, remove Payment Pending */
      await ghl.addContactTags(ghlLocationId, paymentSession.contact_id, [
        "paid_via_chat",
        "stripe_payment_complete",
      ]);
      await ghl.removeContactTags(ghlLocationId, paymentSession.contact_id, [
        "Payment Pending",
      ]);
    } catch (err) {
      console.error(
        "[payment-processor] GHL stage/tag update failed:",
        err,
      );
    }

    return { appointmentId: appointment.id, messageSent };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
