import { randomBytes } from "node:crypto";

import { recordAuditEvent } from "./audit";
import type { Prisma } from "./generated/prisma/client.ts";
import type { LoyaltyEntryKind } from "./generated/prisma/enums.ts";

/**
 * Darkview's loyalty ledger (ADR-008, DV-090 to DV-096).
 *
 * Shared because the API earns and spends points, and the realtime service
 * refunds bookings automatically (DV-111), which reverses them.
 *
 * **Append-only, idempotent by source.** Every change is a new entry, unique on
 * (user, kind, source). An entry is inserted with ON CONFLICT DO NOTHING and the
 * account moves only when a row was actually written, so the same payment, booking
 * or referee recorded twice changes nothing the second time -- and never aborts the
 * caller's transaction the way a unique violation would.
 *
 * **Tier comes from purchase points only.** `tierPoints` moves on a purchase and on
 * its reversal and on nothing else, so a bonus or an operator adjustment cannot
 * raise a tier.
 *
 * Pass the transaction client: the entry, the account and the audit row share the
 * fate of whatever caused them.
 */

type Tx = Prisma.TransactionClient;

export type LoyaltyScheme = {
  pointsPerGel: number;
  pointsPerGelRedeemed: number;
  welcomeBonusPoints: number;
  referralBonusPoints: number;
  minimumPayableMinor: number;
  progressMarkers: number[];
};

export type LoyaltyTier = {
  code: string;
  nameEn: string;
  nameKa: string;
  thresholdPoints: number;
  discountPercent: number;
};

export async function readLoyaltyScheme(
  reader: Pick<Tx, "loyaltyScheme" | "loyaltyTier">,
): Promise<{ scheme: LoyaltyScheme; tiers: LoyaltyTier[] }> {
  const [scheme, tiers] = await Promise.all([
    reader.loyaltyScheme.findUniqueOrThrow({ where: { id: 1 } }),
    reader.loyaltyTier.findMany({ orderBy: { thresholdPoints: "asc" } }),
  ]);
  if (tiers.length === 0 || tiers[0].thresholdPoints !== 0) {
    throw new Error("The loyalty scheme needs a tier that starts at zero points.");
  }
  return { scheme, tiers };
}

/** The highest tier whose threshold the purchase points reach. */
export function tierFor(tiers: LoyaltyTier[], tierPoints: number): LoyaltyTier {
  return (
    tiers.filter((tier) => tier.thresholdPoints <= Math.max(tierPoints, 0)).at(-1) ??
    tiers[0]
  );
}

/** Crockford base32 without I, L, O, U: read aloud and typed without confusion. */
const REFERRAL_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newReferralCode(): string {
  return Array.from(randomBytes(8), (byte) => REFERRAL_ALPHABET[byte & 31]).join("");
}

/** The user's account, created at the lowest tier the first time it is needed. */
export async function ensureLoyaltyAccount(
  tx: Tx,
  userId: string,
  options: { referredByUserId?: string | null } = {},
) {
  const existing = await tx.loyaltyAccount.findUnique({ where: { userId } });
  if (existing) return existing;

  const { tiers } = await readLoyaltyScheme(tx);
  // 40 bits: a collision is not expected in the life of the club, and the unique
  // index turns one into an error rather than two people sharing a code.
  await tx.loyaltyAccount.createMany({
    data: [
      {
        userId,
        tierCode: tiers[0].code,
        referralCode: newReferralCode(),
        referredByUserId:
          options.referredByUserId && options.referredByUserId !== userId
            ? options.referredByUserId
            : null,
      },
    ],
    skipDuplicates: true,
  });
  return tx.loyaltyAccount.findUniqueOrThrow({ where: { userId } });
}

export type LoyaltyEntry = {
  userId: string;
  kind: LoyaltyEntryKind;
  points: number;
  tierPoints?: number;
  sourceRef: string;
  bookingId?: string | null;
  reason?: string | null;
  actorUserId?: string | null;
  /** Refuse, rather than write, an entry that would take the balance below zero. */
  refuseNegativeBalance?: boolean;
};

export type PostResult =
  | { posted: true; balance: number; tierPoints: number }
  | { posted: false; reason: "DUPLICATE" | "INSUFFICIENT_POINTS" };

/**
 * Append one entry and move the account with it.
 *
 * A spend is claimed with a conditional update on the balance before the entry is
 * written, so two spends racing on one balance cannot both succeed.
 */
export async function postLoyaltyEntry(tx: Tx, entry: LoyaltyEntry): Promise<PostResult> {
  const tierPoints = entry.tierPoints ?? 0;
  await ensureLoyaltyAccount(tx, entry.userId);

  const already = await tx.loyaltyLedgerEntry.findUnique({
    where: {
      userId_kind_sourceRef: {
        userId: entry.userId,
        kind: entry.kind,
        sourceRef: entry.sourceRef,
      },
    },
    select: { id: true },
  });
  if (already) return { posted: false, reason: "DUPLICATE" };

  if (entry.refuseNegativeBalance && entry.points < 0) {
    const { count } = await tx.loyaltyAccount.updateMany({
      where: { userId: entry.userId, balance: { gte: -entry.points } },
      data: {
        balance: { increment: entry.points },
        tierPoints: { increment: tierPoints },
      },
    });
    if (count === 0) return { posted: false, reason: "INSUFFICIENT_POINTS" };
  } else {
    await tx.loyaltyAccount.update({
      where: { userId: entry.userId },
      data: {
        balance: { increment: entry.points },
        tierPoints: { increment: tierPoints },
      },
    });
  }

  const { count } = await tx.loyaltyLedgerEntry.createMany({
    data: [
      {
        userId: entry.userId,
        kind: entry.kind,
        points: entry.points,
        tierPoints,
        sourceRef: entry.sourceRef,
        bookingId: entry.bookingId ?? null,
        reason: entry.reason ?? null,
        actorUserId: entry.actorUserId ?? null,
      },
    ],
    skipDuplicates: true,
  });
  // A concurrent writer recorded the same event between the read and the insert.
  // Its account change stands; this one must not.
  if (count === 0) {
    await tx.loyaltyAccount.update({
      where: { userId: entry.userId },
      data: {
        balance: { increment: -entry.points },
        tierPoints: { increment: -tierPoints },
      },
    });
    return { posted: false, reason: "DUPLICATE" };
  }

  const account = await tx.loyaltyAccount.findUniqueOrThrow({
    where: { userId: entry.userId },
  });

  await recordAuditEvent(
    {
      category: "LOYALTY",
      action: `LOYALTY_${entry.kind}`,
      actorUserId: entry.actorUserId ?? null,
      entityType: "LoyaltyAccount",
      entityId: entry.userId,
      detail: {
        points: entry.points,
        tierPoints,
        sourceRef: entry.sourceRef,
        bookingId: entry.bookingId ?? null,
        reason: entry.reason ?? null,
        balance: account.balance,
      },
    },
    tx,
  );

  if (tierPoints !== 0) {
    const { tiers } = await readLoyaltyScheme(tx);
    const tier = tierFor(tiers, account.tierPoints);
    if (tier.code !== account.tierCode) {
      await tx.loyaltyAccount.update({
        where: { userId: entry.userId },
        data: { tierCode: tier.code },
      });
      await recordAuditEvent(
        {
          category: "LOYALTY",
          action: "LOYALTY_TIER_CHANGED",
          actorUserId: null,
          entityType: "LoyaltyAccount",
          entityId: entry.userId,
          detail: {
            from: account.tierCode,
            to: tier.code,
            tierPoints: account.tierPoints,
          },
        },
        tx,
      );
    }
  }

  return { posted: true, balance: account.balance, tierPoints: account.tierPoints };
}

/** Points a settled payment earns: whole points only, rounded down. */
export function pointsEarnedFor(scheme: LoyaltyScheme, amountMinor: number): number {
  return Math.floor((amountMinor * scheme.pointsPerGel) / 100);
}

/**
 * Earn on a payment that settled and delivered what it bought (DV-093). A payment
 * captured for a slot somebody else took earns nothing: nothing was bought.
 */
export async function earnOnSettledPayment(
  tx: Tx,
  payment: { id: string; userId: string; amountMinor: number },
  bookingId: string | null,
): Promise<void> {
  const { scheme } = await readLoyaltyScheme(tx);
  const points = pointsEarnedFor(scheme, payment.amountMinor);
  if (points <= 0) return;
  await postLoyaltyEntry(tx, {
    userId: payment.userId,
    kind: "PURCHASE_EARNED",
    points,
    tierPoints: points,
    sourceRef: `payment:${payment.id}`,
    bookingId,
  });
}

/**
 * The referral bonus, to both sides, on the referred customer's first paid booking
 * (DV-096, maintainer decision of 2026-09-16). Claimed by a conditional update on
 * `referralRewardedAt`, so a second paid booking or a repeated callback grants
 * nothing. A bonus never raises a tier.
 */
export async function rewardReferralOnFirstPaidBooking(
  tx: Tx,
  refereeId: string,
): Promise<void> {
  const account = await tx.loyaltyAccount.findUnique({
    where: { userId: refereeId },
    select: { referredByUserId: true, referralRewardedAt: true },
  });
  if (!account?.referredByUserId || account.referralRewardedAt) return;

  const { count } = await tx.loyaltyAccount.updateMany({
    where: { userId: refereeId, referralRewardedAt: null },
    data: { referralRewardedAt: new Date() },
  });
  if (count === 0) return;

  const { scheme } = await readLoyaltyScheme(tx);
  if (scheme.referralBonusPoints <= 0) return;
  for (const userId of [refereeId, account.referredByUserId]) {
    await postLoyaltyEntry(tx, {
      userId,
      kind: "REFERRAL_BONUS",
      points: scheme.referralBonusPoints,
      sourceRef: `referee:${refereeId}`,
    });
  }
}

/**
 * Give back the points a booking spent, when the booking did not happen: its hold
 * lapsed, its payment failed, it was cancelled unpaid, or it was refunded. One
 * entry per booking however many of those paths reach it.
 */
export async function releaseRedeemedPoints(
  tx: Tx,
  booking: { id: string; userId: string; loyaltyPointsRedeemed: number },
): Promise<void> {
  if (booking.loyaltyPointsRedeemed <= 0) return;
  await postLoyaltyEntry(tx, {
    userId: booking.userId,
    kind: "REDEMPTION_RELEASED",
    points: booking.loyaltyPointsRedeemed,
    sourceRef: `booking:${booking.id}`,
    bookingId: booking.id,
  });
}

/**
 * Reverse what a refunded payment earned, and give back what its booking spent
 * (DV-111). The reversal is the exact amount the earn entry recorded, so a rate
 * changed since then does not change what is taken back. It may take the balance
 * below zero when the points were already spent; the tier falls with it.
 */
export async function reverseLoyaltyForRefund(
  tx: Tx,
  payment: { id: string; userId: string },
  booking: { id: string; userId: string; loyaltyPointsRedeemed: number } | null,
): Promise<void> {
  const earned = await tx.loyaltyLedgerEntry.findUnique({
    where: {
      userId_kind_sourceRef: {
        userId: payment.userId,
        kind: "PURCHASE_EARNED",
        sourceRef: `payment:${payment.id}`,
      },
    },
    select: { points: true, tierPoints: true, bookingId: true },
  });
  if (earned) {
    await postLoyaltyEntry(tx, {
      userId: payment.userId,
      kind: "PURCHASE_REVERSED",
      points: -earned.points,
      tierPoints: -earned.tierPoints,
      sourceRef: `payment:${payment.id}`,
      bookingId: earned.bookingId,
    });
  }
  if (booking) await releaseRedeemedPoints(tx, booking);
}
