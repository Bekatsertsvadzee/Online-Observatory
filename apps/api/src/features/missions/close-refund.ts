import "server-only";

import type { Prisma } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";
import { reverseLoyaltyForRefund } from "@darkview/db/loyalty";
import { queueEmail } from "@darkview/db/notifications";

/**
 * A close refunds the time it takes (ADR-036).
 *
 * A seat is a flat price for the rest of a live session from the moment it is
 * paid. When the owner closes the session to observers the minutes still to come
 * are taken back, so those minutes are what is returned:
 *
 *   refund = ceil(priceMinor × (expiresAt − closedAt) ÷ (expiresAt − paidAt))
 *
 * rounded up to the whole tetri and never more than was paid. Integer arithmetic
 * on milliseconds, in BigInt so the product cannot lose precision. Never a float:
 * this is money.
 *
 * Zero when the close comes at or after the session's end -- nothing was lost --
 * and zero when the seat was somehow paid at or after the end, where there was no
 * time to lose and the division has no denominator.
 */
const ZERO = BigInt(0);
const ONE = BigInt(1);

export function closeRefundMinor(input: {
  priceMinor: number;
  paidAt: Date;
  closedAt: Date;
  expiresAt: Date;
}): number {
  const price = BigInt(input.priceMinor);
  const end = BigInt(input.expiresAt.getTime());
  const remaining = end - BigInt(input.closedAt.getTime());
  const bought = end - BigInt(input.paidAt.getTime());

  if (price <= ZERO || remaining <= ZERO || bought <= ZERO) return 0;
  // A close stamped before the payment settled (clock skew between writers) has
  // taken all of it, and no more than all of it.
  if (remaining >= bought) return input.priceMinor;

  return Number((price * remaining + bought - ONE) / bought);
}

export type CloseRefundSummary = {
  /** Seats refunded, money returned. */
  refunded: number;
  /** Seats whose refund is recorded as owed: the provider cannot issue it yet. */
  owed: number;
  /** Seats that lost no time, because the close came at or after the session's end. */
  nothingLost: number;
  /** Seats not refunded because the session's end is unknown. */
  undetermined: number;
};

/**
 * Refund every paid seat the close takes back. Call it in the close transaction,
 * before the seats are marked LEFT, with the mission row already locked.
 *
 * **Who.** Every PAID pack on the mission, except a buyer whose seat was already
 * LEFT before this close: ADR-036 refunds nobody who left on their own. A buyer who
 * paid and had not attached yet loses the same minutes as one watching, and is
 * refunded the same way -- the pack is the seat, not the connection.
 *
 * **Once.** A pack is written only while both refund columns are null, by a
 * conditional update. A second close, or a close after a reopen, finds the
 * columns set and refunds nothing; a concurrent close loses the update and writes
 * nothing.
 *
 * **Sandbox only, today.** As in DV-111, no live provider's refund API is
 * integrated. A SANDBOX payment is refunded; any other provider's refund is
 * recorded in `refundOwedMinor` and `refundedMinor` stays null, so an owed refund
 * is never presented as paid.
 *
 * **The payment row.** A partial refund leaves the payment CAPTURED -- it was
 * captured, and the pack says what came back. Only a refund of the whole price
 * marks it REFUNDED, the way DV-111 does, and reverses the loyalty points it
 * earned. A partial refund leaves those points alone; DV-093 has no proportional
 * reversal.
 */
export async function refundSeatsTakenByClose(
  tx: Prisma.TransactionClient,
  input: { missionId: string; actorUserId: string; closedAt: Date; isDemo: boolean },
): Promise<CloseRefundSummary> {
  const { missionId, actorUserId, closedAt, isDemo } = input;
  const summary: CloseRefundSummary = {
    refunded: 0,
    owed: 0,
    nothingLost: 0,
    undetermined: 0,
  };

  const leftOnTheirOwn = new Set(
    (
      await tx.missionParticipant.findMany({
        where: { missionId, status: "LEFT" },
        select: { userId: true },
      })
    ).map((row) => row.userId),
  );

  const packs = (
    await tx.observerPack.findMany({
      where: {
        missionId,
        status: "PAID",
        refundedMinor: null,
        refundOwedMinor: null,
        payment: { status: "CAPTURED" },
      },
      select: {
        id: true,
        userId: true,
        priceMinor: true,
        currency: true,
        paidAt: true,
        payment: { select: { id: true, userId: true, provider: true } },
      },
    })
  ).filter((pack) => !leftOnTheirOwn.has(pack.userId));

  if (packs.length === 0) return summary;

  const expiresAt = await sessionEnd(tx, missionId);

  for (const pack of packs) {
    // ObserverPack_paid_has_payment guarantees both for a PAID pack.
    if (!pack.payment || !pack.paidAt) continue;

    if (!expiresAt) {
      summary.undetermined += 1;
      continue;
    }

    const amount = closeRefundMinor({
      priceMinor: pack.priceMinor,
      paidAt: pack.paidAt,
      closedAt,
      expiresAt,
    });
    if (amount <= 0) {
      summary.nothingLost += 1;
      continue;
    }

    const issued = pack.payment.provider === "SANDBOX";
    const { count } = await tx.observerPack.updateMany({
      where: { id: pack.id, refundedMinor: null, refundOwedMinor: null },
      data: issued
        ? { refundedMinor: amount, refundedAt: closedAt }
        : { refundOwedMinor: amount },
    });
    if (count === 0) continue;

    const detail = {
      paymentId: pack.payment.id,
      provider: pack.payment.provider,
      priceMinor: pack.priceMinor,
      currency: pack.currency,
      paidAt: pack.paidAt.toISOString(),
      closedAt: closedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    if (!issued) {
      await recordAuditEvent(
        {
          category: "PAYMENT",
          action: "OBSERVER_PACK_REFUND_OWED",
          actorUserId,
          missionId,
          entityType: "ObserverPack",
          entityId: pack.id,
          detail: {
            ...detail,
            refundOwedMinor: amount,
            reason: "PROVIDER_REFUND_UNAVAILABLE",
          },
          isDemo,
        },
        tx,
      );
      summary.owed += 1;
      continue;
    }

    if (amount === pack.priceMinor) {
      await tx.payment.update({
        where: { id: pack.payment.id },
        data: { status: "REFUNDED", refundedAt: closedAt },
      });
      await reverseLoyaltyForRefund(tx, pack.payment, null);
    }

    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "OBSERVER_PACK_REFUNDED",
        actorUserId,
        missionId,
        entityType: "ObserverPack",
        entityId: pack.id,
        detail: { ...detail, refundedMinor: amount },
        isDemo,
      },
      tx,
    );

    await queueEmail(tx, {
      userId: pack.userId,
      kind: "OBSERVER_PACK_REFUNDED",
      dedupeKey: `observer-pack-refunded:${pack.id}`,
      payload: { observerPackId: pack.id },
    });

    summary.refunded += 1;
  }

  return summary;
}

/**
 * The session's end: the `expiresAt` of the owner's latest session, which is the
 * end of the booked slot for a booked mission (`sessionExpiry` in session.ts). A
 * mission that never opened a session falls back to its booking's slot end, and
 * one with neither has no end anybody could have bought time against.
 */
async function sessionEnd(
  tx: Prisma.TransactionClient,
  missionId: string,
): Promise<Date | null> {
  const session = await tx.missionSession.findFirst({
    where: { missionId },
    orderBy: { issuedAt: "desc" },
    select: { expiresAt: true },
  });
  if (session) return session.expiresAt;

  const booking = await tx.booking.findUnique({
    where: { missionId },
    select: { slotStartAt: true, durationMinutes: true },
  });
  if (!booking) return null;
  return new Date(booking.slotStartAt.getTime() + booking.durationMinutes * 60_000);
}
