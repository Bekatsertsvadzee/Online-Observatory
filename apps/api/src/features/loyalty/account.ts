import "server-only";

import type {
  ErrorCode,
  LoyaltyAccount,
  LoyaltyAdjustmentRequest,
  LoyaltyScheme,
} from "@darkview/contracts";
import {
  ensureLoyaltyAccount,
  postLoyaltyEntry,
  readLoyaltyScheme,
  tierFor,
} from "@darkview/db/loyalty";

import { getDatabase } from "@/lib/db/client";

/** DV-091: the loyalty club as the contract shows it. */

const RECENT_ENTRIES = 50;

export async function readPublicLoyaltyScheme(): Promise<LoyaltyScheme> {
  const { scheme, tiers } = await readLoyaltyScheme(getDatabase());
  return {
    pointsPerGel: scheme.pointsPerGel,
    pointsPerGelRedeemed: scheme.pointsPerGelRedeemed,
    welcomeBonusPoints: scheme.welcomeBonusPoints,
    referralBonusPoints: scheme.referralBonusPoints,
    minimumPayableMinor: scheme.minimumPayableMinor,
    progressMarkers: scheme.progressMarkers,
    tiers,
  };
}

export async function readLoyaltyAccount(userId: string): Promise<LoyaltyAccount> {
  const database = getDatabase();
  const account = await database.$transaction((tx) => ensureLoyaltyAccount(tx, userId));
  const [{ tiers }, entries] = await Promise.all([
    readLoyaltyScheme(database),
    database.loyaltyLedgerEntry.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RECENT_ENTRIES,
    }),
  ]);
  const tier = tierFor(tiers, account.tierPoints);
  return {
    userId,
    balance: account.balance,
    tierPoints: account.tierPoints,
    tier,
    nextTier:
      tiers.find((candidate) => candidate.thresholdPoints > tier.thresholdPoints) ?? null,
    referralCode: account.referralCode,
    recentEntries: entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      points: entry.points,
      tierPoints: entry.tierPoints,
      bookingId: entry.bookingId,
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

export async function adjustLoyaltyPoints(input: {
  request: LoyaltyAdjustmentRequest;
  operatorId: string;
}): Promise<
  | { ok: true; account: LoyaltyAccount }
  | { ok: false; status: 404 | 409 | 422; code: ErrorCode; message: string }
> {
  const { request, operatorId } = input;
  if (request.points === 0) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "An adjustment of zero points changes nothing.",
    };
  }

  const database = getDatabase();
  const user = await database.user.findUnique({
    where: { id: request.userId },
    select: { id: true },
  });
  if (!user)
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such user." };

  const result = await database.$transaction((tx) =>
    postLoyaltyEntry(tx, {
      userId: request.userId,
      kind: "ADMIN_ADJUSTMENT",
      points: request.points,
      sourceRef: `adjustment:${request.adjustmentId}`,
      reason: request.reason,
      actorUserId: operatorId,
      refuseNegativeBalance: true,
    }),
  );
  if (!result.posted && result.reason === "INSUFFICIENT_POINTS") {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "The balance cannot go below zero.",
    };
  }

  return { ok: true, account: await readLoyaltyAccount(request.userId) };
}
