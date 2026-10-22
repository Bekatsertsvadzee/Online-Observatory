import { recordAuditEvent } from "./audit";
import type { Prisma } from "./generated/prisma/client.ts";
import { RESTORED_VOUCHER_MIN_DAYS } from "./vouchers";

/**
 * Giving a card-draw prize back (ADR-060).
 *
 * Shared because a prize comes back on paths both services take: a held booking that
 * lapses or whose payment fails (the API), and a refunded booking (the API, and the
 * realtime service when an entitlement reaches its thirty days).
 *
 * **A lapsed or failed hold** spent the prize on nothing: it is ACTIVE again with the
 * expiry it had. **A refunded booking** restores it as DV-111 restores a gift voucher:
 * usable for at least RESTORED_VOUCHER_MIN_DAYS, however little of its life was left.
 *
 * Conditional on the prize still being spent on that booking, so a second call writes
 * nothing. Pass the transaction client: the prize and the booking share one fate.
 */
export async function releaseCardPrize(
  tx: Prisma.TransactionClient,
  input: {
    bookingId: string;
    cause: "HOLD_RELEASED" | "BOOKING_REFUNDED";
    actorUserId: string | null;
    now: Date;
  },
): Promise<{ prizeId: string } | null> {
  const prize = await tx.cardPrize.findUnique({
    where: { redeemedBookingId: input.bookingId },
    select: { id: true, status: true, expiresAt: true, isDemo: true },
  });
  if (!prize || prize.status !== "REDEEMED") return null;

  const floor = new Date(input.now.getTime() + RESTORED_VOUCHER_MIN_DAYS * 86_400_000);
  const expiresAt =
    input.cause === "BOOKING_REFUNDED" && prize.expiresAt < floor
      ? floor
      : prize.expiresAt;

  const { count } = await tx.cardPrize.updateMany({
    where: { id: prize.id, status: "REDEEMED", redeemedBookingId: input.bookingId },
    data: { status: "ACTIVE", expiresAt, redeemedAt: null, redeemedBookingId: null },
  });
  if (count === 0) return null;

  await recordAuditEvent(
    {
      category: "CARD_DRAW",
      action: "CARD_PRIZE_RESTORED",
      actorUserId: input.actorUserId,
      entityType: "CardPrize",
      entityId: prize.id,
      detail: {
        bookingId: input.bookingId,
        cause: input.cause,
        expiresAt: expiresAt.toISOString(),
      },
      isDemo: prize.isDemo,
    },
    tx,
  );
  return { prizeId: prize.id };
}
