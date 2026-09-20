import { recordAuditEvent } from "./audit";
import { releaseSpentMinutes } from "./credits";
import type { Prisma } from "./generated/prisma/client.ts";
import { reverseLoyaltyForRefund } from "./loyalty";
import { queueEmail } from "./notifications";
import { RESTORED_VOUCHER_MIN_DAYS } from "./vouchers";

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
 * **A voucher is restored, never paid out** (DV-112). When the chain ends at a
 * booking a gift voucher paid for, the voucher becomes usable again instead.
 *
 * **Minutes are returned, never paid out** (ADR-022 section 7). When the chain ends
 * at a booking subscription minutes paid for, the minutes go back on the balance.
 *
 * Pass the transaction client. The entitlement, the payment, the booking, the
 * audit row and the email share one fate.
 */
export type RefundRefusal =
  | "NO_OPEN_ENTITLEMENT"
  | "NOTHING_TO_REFUND"
  | "PROVIDER_REFUND_UNAVAILABLE";

export type RefundResult =
  | { ok: true; paymentId: string | null; voucherId: string | null; minutesReturned: number }
  | { ok: false; reason: RefundRefusal };

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
    userId: string;
    provider: string;
    status: string;
    amountMinor: number;
    currency: string;
  };

  type VoucherSummary = { id: string; expiresAt: Date | null };

  type MinutesBooking = { id: string; userId: string; subscriptionMinutesSpent: number };

  let payment = null as PaymentSummary | null;
  let voucher = null as VoucherSummary | null;
  let minutesBooking = null as MinutesBooking | null;
  let current: string | null = bookingId;
  for (let step = 0; current && step < MAX_RESCHEDULE_CHAIN; step += 1) {
    const booking: {
      id: string;
      userId: string;
      subscriptionMinutesSpent: number;
      payment: PaymentSummary | null;
      redeemedVoucher: VoucherSummary | null;
      rescheduledFrom: { bookingId: string } | null;
    } = await tx.booking.findUniqueOrThrow({
      where: { id: current },
      select: {
        id: true,
        userId: true,
        subscriptionMinutesSpent: true,
        payment: {
          select: {
            id: true,
            userId: true,
            provider: true,
            status: true,
            amountMinor: true,
            currency: true,
          },
        },
        redeemedVoucher: { select: { id: true, expiresAt: true } },
        rescheduledFrom: { select: { bookingId: true } },
      },
    });
    if (booking.payment) {
      payment = booking.payment;
      break;
    }
    if (booking.redeemedVoucher) {
      voucher = booking.redeemedVoucher;
      break;
    }
    if (booking.subscriptionMinutesSpent > 0) {
      minutesBooking = booking;
      break;
    }
    current = booking.rescheduledFrom?.bookingId ?? null;
  }

  if (voucher) return restoreVoucher(tx, { entitlementId: entitlement.id, userId: entitlement.userId, bookingId, voucher, actorUserId, automatic, now });
  if (minutesBooking) return returnMinutes(tx, { entitlementId: entitlement.id, bookingId, paidBooking: minutesBooking, actorUserId, automatic, now });

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

  // DV-093: what the refunded payment earned is taken back, and what its booking
  // spent in points is given back. The paid booking is the one at the root of a
  // reschedule chain, where the points were spent.
  const paidBooking = await tx.booking.findFirst({
    where: { paymentId: payment.id },
    select: { id: true, userId: true, loyaltyPointsRedeemed: true },
  });
  await reverseLoyaltyForRefund(tx, payment, paidBooking);

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

  return { ok: true, paymentId: payment.id, voucherId: null, minutesReturned: 0 };
}

async function restoreVoucher(
  tx: Prisma.TransactionClient,
  input: {
    entitlementId: string;
    userId: string;
    bookingId: string;
    voucher: { id: string; expiresAt: Date | null };
    actorUserId: string | null;
    automatic: boolean;
    now: Date;
  },
): Promise<RefundResult> {
  const { entitlementId, userId, bookingId, voucher, actorUserId, automatic, now } = input;

  const { count } = await tx.bookingEntitlement.updateMany({
    where: { id: entitlementId, outcome: "OPEN" },
    data: { outcome: "REFUNDED", resolvedAt: now },
  });
  if (count === 0) return { ok: false, reason: "NO_OPEN_ENTITLEMENT" };

  const floor = new Date(now.getTime() + RESTORED_VOUCHER_MIN_DAYS * 86_400_000);
  const expiresAt = voucher.expiresAt && voucher.expiresAt > floor ? voucher.expiresAt : floor;

  await tx.giftVoucher.update({
    where: { id: voucher.id },
    data: {
      status: "ACTIVE",
      expiresAt,
      redeemedAt: null,
      redeemedByUserId: null,
      redeemedBookingId: null,
    },
  });
  await tx.booking.update({ where: { id: bookingId }, data: { status: "REFUNDED" } });

  await recordAuditEvent(
    {
      category: "BOOKING",
      action: "GIFT_VOUCHER_RESTORED",
      actorUserId,
      entityType: "GiftVoucher",
      entityId: voucher.id,
      detail: { bookingId, expiresAt: expiresAt.toISOString(), automatic },
    },
    tx,
  );

  await queueEmail(tx, {
    userId,
    kind: "GIFT_VOUCHER_RESTORED",
    dedupeKey: `gift-voucher-restored:${voucher.id}:${bookingId}`,
    payload: { voucherId: voucher.id, bookingId },
  });

  return { ok: true, paymentId: null, voucherId: voucher.id, minutesReturned: 0 };
}

/**
 * The paid booking is the root of the reschedule chain, where the minutes were
 * spent, so the release is keyed on it and a chain refunds its minutes once.
 *
 * Its own email (#123), not BOOKING_REFUNDED: that one states an amount of money,
 * and none moved.
 */
async function returnMinutes(
  tx: Prisma.TransactionClient,
  input: {
    entitlementId: string;
    bookingId: string;
    paidBooking: { id: string; userId: string; subscriptionMinutesSpent: number };
    actorUserId: string | null;
    automatic: boolean;
    now: Date;
  },
): Promise<RefundResult> {
  const { entitlementId, bookingId, paidBooking, actorUserId, automatic, now } = input;

  const { count } = await tx.bookingEntitlement.updateMany({
    where: { id: entitlementId, outcome: "OPEN" },
    data: { outcome: "REFUNDED", resolvedAt: now },
  });
  if (count === 0) return { ok: false, reason: "NO_OPEN_ENTITLEMENT" };

  await releaseSpentMinutes(tx, paidBooking, now);
  await tx.booking.update({ where: { id: bookingId }, data: { status: "REFUNDED" } });

  await recordAuditEvent(
    {
      category: "BOOKING",
      action: "BOOKING_MINUTES_RETURNED",
      actorUserId,
      entityType: "Booking",
      entityId: bookingId,
      detail: {
        paidBookingId: paidBooking.id,
        minutes: paidBooking.subscriptionMinutesSpent,
        automatic,
      },
    },
    tx,
  );

  await queueEmail(tx, {
    userId: paidBooking.userId,
    kind: "SUBSCRIPTION_MINUTES_RETURNED",
    dedupeKey: `minutes-returned:${bookingId}`,
    payload: { bookingId, paidBookingId: paidBooking.id },
  });

  return {
    ok: true,
    paymentId: null,
    voucherId: null,
    minutesReturned: paidBooking.subscriptionMinutesSpent,
  };
}
