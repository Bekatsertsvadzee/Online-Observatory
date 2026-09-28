import "server-only";

import type { Booking, BookingPage, ErrorCode } from "@darkview/contracts";
import { zBookingId } from "@darkview/contracts/zod";

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
 * The signed-in customer's bookings, latest slot first.
 *
 * Scoped by `userId` in the WHERE clause, as `GET /missions` and the Collection
 * are, so another customer's booking is never fetched and cannot leak through a
 * page edge. Ordered by `slotStartAt` -- when the observation is, which is what
 * the customer is looking for -- with the id as the tiebreak a keyset cursor needs.
 *
 * The cursor is the last id of the previous page. One that is not one of the
 * caller's bookings -- malformed, unknown, or somebody else's -- ends the list: an
 * empty page, never an error that would tell a prober which ids exist.
 */
export async function listMyBookings(input: {
  userId: string;
  cursor?: string;
  limit: number;
}): Promise<BookingPage> {
  const { userId, cursor, limit } = input;
  const database = getDatabase();
  const empty: BookingPage = { items: [], page: { hasMore: false, nextCursor: null } };

  if (cursor !== undefined) {
    if (!zBookingId.safeParse(cursor).success) return empty;
    const owned = await database.booking.findFirst({
      where: { id: cursor, userId },
      select: { id: true },
    });
    if (!owned) return empty;
  }

  const rows = await database.booking.findMany({
    where: { userId },
    orderBy: [{ slotStartAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { entitlement: BOOKING_ENTITLEMENT_SELECT },
  });

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    items: items.map(toContractBooking),
    page: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
  };
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
  /** Passed in rather than read here, because returning the booking's minutes
   * depends on whether the subscription period they were spent in is still
   * running (ADR-022: minutes expire at period end). */
  now: Date;
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

    await releaseHeldSlot(tx, booking, reason, input.now);

    return {
      ok: true,
      booking: toContractBooking(await tx.booking.findUniqueOrThrow({ where: { id: owned.id } })),
    } as const;
  });
}
