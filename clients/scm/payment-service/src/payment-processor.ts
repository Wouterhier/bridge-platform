import { Pool } from "pg";
import type { createGhlClient } from "@romea/ghl-client";
import type { createAcuityClient } from "@romea/acuity-client";
import type { createStripeClient } from "@romea/stripe-client";
import { generate, gateApiCall } from "@romea/scm-flow";
import type { ScmCollected } from "@romea/scm-flow";
import { mapIntakeFields } from "@romea/acuity-client";
import type { ModelRouter } from "@romea/model-router";
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
  inbound_channel: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const STAGE_INITIAL_CONSULTATION_SCHEDULED =
  "750a6c84-d60f-424a-ac88-876d06fa362d";

/* Channels that GHL accepts for outbound sends */
type GhlChannel = "SMS" | "Live_Chat" | "WhatsApp" | "Email";

function resolveChannel(raw: string): GhlChannel {
  const map: Record<string, GhlChannel> = {
    live_chat: "Live_Chat",
    livechat: "Live_Chat",
    sms: "SMS",
    whatsapp: "WhatsApp",
    email: "Email",
  };
  return map[raw.toLowerCase()] ?? "SMS";
}

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

    /* 1. SELECT payment_sessions FOR UPDATE */
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
         (stripe_session_id, status, slot_iso, appointment_type_id, contact_id, conversation_id, idempotency_key, collected_fields, inbound_channel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
          metadata.inbound_channel ?? "SMS",
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

    /* 2. UPDATE status = 'paid' */
    await client.query(
      `UPDATE payment_sessions
       SET status = 'paid', paid_at = now(), updated_at = now()
       WHERE id = $1`,
      [paymentSession.id],
    );

    /* 3. GATE: verify all mandatory fields before booking.
          A paid booking that can't complete is urgent — patient has paid.
          Block, log, and escalate rather than book with missing data. */
    const collected = paymentSession.collected_fields as ScmCollected;
    const appointmentTypeId = Number(paymentSession.appointment_type_id);

    const gate = gateApiCall(appointmentTypeId, collected as Record<string, unknown>);
    if (!gate.ready) {
      const missingKeys = gate.missing.map((f: { key: string }) => f.key).join(", ");
      process.stderr.write(
        `[payment-processor] URGENT: gate blocked on paid booking — missing fields: ${missingKeys} ` +
        `session=${session.id} contact=${paymentSession.contact_id}\n`,
      );

      /* Mark for manual review */
      await client.query(
        `UPDATE payment_sessions
         SET status = 'manual_review', updated_at = now()
         WHERE id = $1`,
        [paymentSession.id],
      );
      await client.query("COMMIT");

      /* Escalate to HUMAN_TOUCH in conversations */
      if (paymentSession.conversation_id) {
        await db.query(
          `UPDATE conversations
           SET current_state = 'HUMAN_TOUCH', updated_at = now()
           WHERE id = $1`,
          [paymentSession.conversation_id],
        );
      }

      /* Alert via GHL Human Touch stage */
      try {
        const opps = await ghl.getPipelineOpportunities(ghlLocationId, paymentSession.contact_id, ghlPipelineId);
        if (opps.length > 0) {
          const HUMAN_TOUCH = "d1cb71e3-4e11-4b7b-bf67-2cf5a2e541a5";
          await ghl.updateOpportunityStageSafe(ghlLocationId, opps[0].id, HUMAN_TOUCH, opps[0].pipelineStageId);
        }
        await ghl.addContactTags(ghlLocationId, paymentSession.contact_id, [
          "payment_gate_blocked",
          "manual_review_required",
        ]);
      } catch (e) {
        process.stderr.write(`[payment-processor] escalation GHL call failed: ${String(e)}\n`);
      }

      throw new Error(
        `[payment-processor] URGENT: paid booking blocked — mandatory fields missing (${missingKeys}). ` +
        `Session ${session.id} marked manual_review. Human intervention required.`,
      );
    }

    /* 4. Name check: gate requires fullName per field-spec; validate it splits cleanly */
    const fullName = (collected.fullName as string | undefined) ?? "";
    if (!fullName.trim()) {
      /* Should have been caught by gate, but belt-and-suspenders */
      await client.query("ROLLBACK");
      throw new Error(
        `[payment-processor] URGENT: paid booking has empty fullName after gate pass. ` +
        `Session ${session.id} — field-spec may be missing fullName as mandatory. Human review required.`,
      );
    }
    const [firstName, ...lastNameParts] = fullName.trim().split(/\s+/);
    const lastName = lastNameParts.join(" ");

    /* 5. Build Acuity payload using the same validated path as the free booking.
          gate.payload contains only code-validated, normalized values. */
    const serviceKey =
      typeof collected.serviceKey === "string"
        ? collected.serviceKey
        : (collected.serviceKey as { key?: string } | undefined)?.key ?? "";

    /* Build Acuity intake fields from the gate's validated+normalized payload.
       This is identical to handleBookingAcuity in conversation-service.ts —
       both paths now use gate.payload as the source of truth, never raw collected. */
    const acuityFields = mapIntakeFields(serviceKey, {
      firstName,
      lastName,
      patientName: fullName,
      email: gate.payload.email as string,
      phone: gate.payload.phone as string | undefined,
      dob: gate.payload.dob as string | undefined,
      address: gate.payload.address as string | undefined,
      currentMedications: gate.payload.medications as string | undefined,
      gpName: gate.payload.gpName as string | undefined,
      questionsToDiscuss: gate.payload.questions as string | undefined,
    });

    /* 6. Create Acuity appointment */
    const appointment = await acuity.createAppointment({
      appointmentTypeID: appointmentTypeId,
      datetime: paymentSession.slot_iso,
      firstName,
      lastName,
      email: (gate.payload.email as string) ?? (collected.email as string) ?? session.customer_email ?? "",
      phone: gate.payload.phone as string | undefined,
      fields: acuityFields,
      idempotencyKey:
        paymentSession.idempotency_key ??
        `scm-booking-${paymentSession.conversation_id}-${paymentSession.slot_iso}`,
      paymentSessionId: paymentSession.id,
    });

    /* 7. UPDATE acuity_appointment_id */
    await client.query(
      `UPDATE payment_sessions
       SET acuity_appointment_id = $1, updated_at = now()
       WHERE id = $2`,
      [String(appointment.id), paymentSession.id],
    );

    /* 8. UPDATE conversations state */
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

    /* 9. Generate confirmation message */
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

    /* 10. Resolve channel — use the channel the patient originally used */
    const channel = resolveChannel(paymentSession.inbound_channel ?? "SMS");

    /* 11. Record processed_messages BEFORE sending (inside tx).
           sent_at left NULL so recoverUnsentReplies() can retry on crash. */
    const confirmMessageId = `scm-confirm-${paymentSession.id}`;
    const sendPayload = {
      type: channel,
      contactId: paymentSession.contact_id,
      message: replyText,
      locationId: ghlLocationId,
    } as import("@romea/bridge-db").SendPayload;

    await markMessageProcessed(client, confirmMessageId, paymentSession.contact_id, sendPayload);

    /* 12. Commit transaction */
    await client.query("COMMIT");

    /* 13. Send confirmation via GHL (outside tx) */
    let messageSent = false;
    try {
      await ghl.sendMessage(ghlLocationId, paymentSession.contact_id, {
        type: channel,
        contactId: paymentSession.contact_id,
        message: replyText,
      });
      messageSent = true;
      await markMessageSent(db, confirmMessageId);
    } catch (err) {
      console.error("[payment-processor] GHL send failed:", err);
      /* sent_at stays NULL — recoverUnsentReplies will retry */
    }

    /* 14. Update GHL opportunity stage and tags */
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
          name: fullName || "New Lead",
        });
      }

      await ghl.addContactTags(ghlLocationId, paymentSession.contact_id, [
        "paid_via_chat",
        "stripe_payment_complete",
      ]);
      await ghl.removeContactTags(ghlLocationId, paymentSession.contact_id, [
        "Payment Pending",
      ]);
    } catch (err) {
      console.error("[payment-processor] GHL stage/tag update failed:", err);
    }

    return { appointmentId: appointment.id, messageSent };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
