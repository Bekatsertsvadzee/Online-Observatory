import "server-only";

import type { Booking, ErrorCode } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import {
  BOOKING_ENTITLEMENT_SELECT,
  releaseHeldSlot,
  toContractBooking,
} from "@/features/booking/reserve";

type Refusal = { ok: false; status: 404 | 409; code: ErrorCode; message: string };

const notFound: Refusal = { ok: false, status: 404, code: "NOT_FOUND", message: "No such booking." };

/** One booking the caller owns, or null -- for one that is not theirs as well. */
export async function getMyBooking(input: {
  userId: string;
  bookingId: string;
}): Promise<Booking | null> {
  const row = await getDatabase().booking.findFirst({
    where: { id: input.bookingId, userId: input.userId },
    include: { entitlement: BOOKING_ENTITLEMENT_SELECT },
  });
  return row ? toContractBooking(row) : null;
}

/**
 * Cancel an unpaid booking and put its slot back on sale.
 *
 * **Only PENDING_PAYMENT.** A CONFIRMED booking has taken the customer's money,
 * and nothing in this repository can give it back until the refund engine
 * (DV-111) exists. Cancelling one now would either keep the money silently or
 * promise a refund nobody issues, so it is refused with 409 by maintainer decision
 * of 2026-09-14, and becomes possible when refunds do.
 *
 * Locks the payment and then the booking -- the order settlement takes them in --
 * so a cancellation racing the provider's callback waits for it rather than
 * deadlocking against it. Whichever commits first wins: a callback that settles
 * first leaves a CONFIRMED booking this refuses, and one that arrives after finds
 * the payment FAILED and records captured money for the refund engine.
 */
export async function cancelMyBooking(input: {
  userId: string;
  bookingId: string;
  reason?: string;
}): Promise<{ ok: true; booking: Booking } | Refusal> {
  const database = getDatabase();

  const owned = await database.booking.findFirst({
    where: { id: input.bookingId, userId: input.userId },
    select: { id: true, paymentId: true },
  });
  if (!owned) return notFound;

  const reason = input.reason
    ? `Cancelled by customer: ${input.reason.slice(0, 500)}`
    : "Cancelled by customer";

  return database.$transaction(async (tx) => {
    if (owned.paymentId) {
      await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${owned.paymentId}::uuid FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${owned.id}::uuid FOR UPDATE`;

    const booking = await tx.booking.findUniqueOrThrow({ where: { id: owned.id } });

    // The payment locked above has to be the booking's payment, or the lock order
    // protected nothing.
    if (booking.paymentId !== owned.paymentId) {
      return { ok: false, status: 409, code: "CONFLICT", message: "The booking changed. Retry." } as const;
    }
    if (booking.status === "CONFIRMED") {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: "A paid booking cannot be cancelled until refunds are available.",
      } as const;
    }
    if (booking.status !== "PENDING_PAYMENT") {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `The booking is already ${booking.status}.`,
      } as const;
    }

    await releaseHeldSlot(tx, booking, reason);

    return {
      ok: true,
      booking: toContractBooking(await tx.booking.findUniqueOrThrow({ where: { id: owned.id } })),
    } as const;
  });
}
