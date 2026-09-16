import { recordAuditEvent } from "./audit";
import type { Prisma } from "./generated/prisma/client.ts";
import { queueEmail } from "./notifications";

/**
 * Refund a booking that holds an open entitlement (DV-111).
 *
 * Shared because two callers refund: the API, when a customer chooses a refund,
 * and the realtime service, when an entitlement reaches its thirty days unused.
 * One implementation means one answer to "which payment gives the money back".
 *
 * **The payment is the one that paid.** A free reschedule has no payment of its
 * own, so the chain is walked back through each entitlement it was made from until
 * a booking with a payment is found. Refunding the rescheduled booking refunds the
 * money the customer originally paid, once.
 *
 * **Sandbox only, today.** No live provider's refund API has been integrated
 * (merchant onboarding delivers that documentation). A live payment is refused as
 * PROVIDER_REFUND_UNAVAILABLE and the entitlement stays open: marking money
 * returned that was never returned would write a fiction into the payment tables.
 *
 * Pass the transaction client. The entitlement, the payment, the booking, the
 * audit row and the email share one fate.
 */
export type RefundRefusal =
  | "NO_OPEN_ENTITLEMENT"
  | "NOTHING_TO_REFUND"
  | "PROVIDER_REFUND_UNAVAILABLE";

export type RefundResult = { ok: true; paymentId: string } | { ok: false; reason: RefundRefusal };

/** A reschedule of a reschedule of ... is legal; a loop is not, and this bounds the walk. */
const MAX_RESCHEDULE_CHAIN = 12;

export async function refundEntitledBooking(
  tx: Prisma.TransactionClient,
  input: { bookingId: string; actorUserId: string | null; automatic: boolean; now: Date },
): Promise<RefundResult> {
  const { bookingId, actorUserId, automatic, now } = input;

  const entitlement = await tx.bookingEntitlement.findUnique({
    where: { bookingId },
    select: { id: true, outcome: true, userId: true },
  });
  if (!entitlement || entitlement.outcome !== "OPEN") {
    return { ok: false, reason: "NO_OPEN_ENTITLEMENT" };
  }

  type PaymentSummary = {
    id: string;
    provider: string;
    status: string;
    amountMinor: number;
    currency: string;
  };

  let payment = null as PaymentSummary | null;
  let current: string | null = bookingId;
  for (let step = 0; current && step < MAX_RESCHEDULE_CHAIN; step += 1) {
    const booking: {
      payment: PaymentSummary | null;
      rescheduledFrom: { bookingId: string } | null;
    } = await tx.booking.findUniqueOrThrow({
      where: { id: current },
      select: {
        payment: {
          select: { id: true, provider: true, status: true, amountMinor: true, currency: true },
        },
        rescheduledFrom: { select: { bookingId: true } },
      },
    });
    if (booking.payment) {
      payment = booking.payment;
      break;
    }
    current = booking.rescheduledFrom?.bookingId ?? null;
  }

  if (!payment || payment.status !== "CAPTURED") {
    return { ok: false, reason: "NOTHING_TO_REFUND" };
  }
  if (payment.provider !== "SANDBOX") {
    return { ok: false, reason: "PROVIDER_REFUND_UNAVAILABLE" };
  }

  // Conditional: a reschedule or a second refund that committed a moment ago wins,
  // and this one writes nothing.
  const { count } = await tx.bookingEntitlement.updateMany({
    where: { id: entitlement.id, outcome: "OPEN" },
    data: { outcome: "REFUNDED", resolvedAt: now },
  });
  if (count === 0) return { ok: false, reason: "NO_OPEN_ENTITLEMENT" };

  await tx.payment.update({
    where: { id: payment.id },
    data: { status: "REFUNDED", refundedAt: now },
  });
  await tx.booking.update({ where: { id: bookingId }, data: { status: "REFUNDED" } });

  await recordAuditEvent(
    {
      category: "PAYMENT",
      action: "PAYMENT_REFUNDED",
      actorUserId,
      entityType: "Payment",
      entityId: payment.id,
      detail: {
        bookingId,
        provider: payment.provider,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        // Whether the customer chose it or thirty days passed without a choice.
        automatic,
      },
    },
    tx,
  );

  await queueEmail(tx, {
    userId: entitlement.userId,
    kind: "BOOKING_REFUNDED",
    dedupeKey: `booking-refunded:${bookingId}`,
    payload: { bookingId },
  });

  return { ok: true, paymentId: payment.id };
}
