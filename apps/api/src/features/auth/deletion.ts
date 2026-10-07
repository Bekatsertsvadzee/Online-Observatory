import "server-only";

import type { AccountDeletionBlocker, DeleteAccountRequest } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";
import { deleteObject } from "@darkview/storage/objects";

import {
  dummyPasswordHash,
  rateLimited,
  refuse,
  type Refusal,
} from "@/features/auth/authenticate";
import { TERMINAL_MISSION_STATES } from "@/features/missions/session";
import { recordAuthEvent } from "@/lib/auth/audit";
import { verifyPassword } from "@/lib/auth/password";
import type { VerifiedSession } from "@/lib/auth/types";
import { getDatabase } from "@/lib/db/client";
import { AUTHENTICATION_POLICY, consumeLimit } from "@/lib/security/rate-limit";
import { getStorage } from "@/lib/storage/configuration";

/**
 * ADR-044: a customer deletes their account.
 *
 * The User row is not deleted. Bookings, payments, the credit ledger and the
 * operational records refuse to lose their owner, and the maintainer's decision keeps
 * the bookings and payments for accounting. So the row stays with the name and email
 * replaced, and everything else that named the person or was theirs to keep -- the
 * password, the sessions, every link, the captures and the Collection, the loyalty
 * points, the outbox -- is deleted in one transaction.
 */
export const DELETED_NAME = "Deleted account";

export function deletedEmail(userId: string) {
  // .invalid never resolves (RFC 2606), and the id keeps the unique index satisfied.
  return `deleted-${userId}@deleted.invalid`;
}

/** A hold is a mission waiting; it may resume only while its slot lasts. */
const HOLD_STATES = ["WEATHER_HOLD", "NOT_VISIBLE", "HARDWARE_ERROR"];

/** Gift vouchers whose money is still outstanding. */
const UNSETTLED_VOUCHER = ["PENDING_PAYMENT", "ACTIVE"] as const;

type Transaction = Parameters<
  Parameters<ReturnType<typeof getDatabase>["$transaction"]>[0]
>[0];

/**
 * Everything that has to be settled before the account can go. Read inside the
 * deleting transaction, which is SERIALIZABLE, so a booking made while it runs makes
 * one of the two fail rather than leaving a paid slot with nobody behind it.
 */
export async function accountDeletionBlockers(
  tx: Transaction,
  userId: string,
  role: string,
  now: Date,
): Promise<AccountDeletionBlocker[]> {
  const blockers: AccountDeletionBlocker[] = [];
  if (role === "OPERATOR") blockers.push("OPERATOR");

  const missions = await tx.mission.findMany({
    where: { userId, state: { notIn: [...TERMINAL_MISSION_STATES] } },
    select: {
      state: true,
      booking: { select: { slotStartAt: true, durationMinutes: true } },
    },
  });
  const missionBlocks = missions.some((mission) => {
    if (!HOLD_STATES.includes(mission.state)) return true;
    // A hold with no booking behind it has no end we can know; it blocks.
    if (!mission.booking) return true;
    return slotEnd(mission.booking) > now;
  });
  if (missionBlocks) blockers.push("LIVE_MISSION");

  const bookings = await tx.booking.findMany({
    where: { userId, status: { in: ["CONFIRMED", "PENDING_PAYMENT"] } },
    select: {
      status: true,
      slotStartAt: true,
      durationMinutes: true,
      holdExpiresAt: true,
    },
  });
  if (
    bookings.some((booking) => booking.status === "CONFIRMED" && slotEnd(booking) > now)
  ) {
    blockers.push("UPCOMING_BOOKING");
  }
  // A lapsed hold the sweep has not reached yet holds nothing.
  if (
    bookings.some(
      (booking) =>
        booking.status === "PENDING_PAYMENT" &&
        booking.holdExpiresAt !== null &&
        booking.holdExpiresAt > now,
    )
  ) {
    blockers.push("HELD_BOOKING");
  }

  const [entitlement, seat, subscription, voucher, node] = await Promise.all([
    tx.bookingEntitlement.findFirst({
      where: { userId, outcome: "OPEN" },
      select: { id: true },
    }),
    tx.observerPack.findFirst({
      where: {
        userId,
        status: { in: ["PENDING_PAYMENT", "PAID"] },
        mission: { state: { notIn: [...TERMINAL_MISSION_STATES] } },
      },
      select: { id: true },
    }),
    tx.subscription.findFirst({
      where: { userId, status: { in: ["TRIALING", "ACTIVE", "PAUSED"] } },
      select: { id: true },
    }),
    tx.giftVoucher.findFirst({
      where: { buyerUserId: userId, status: { in: [...UNSETTLED_VOUCHER] } },
      select: { id: true },
    }),
    tx.observatoryNetworkNode.findFirst({
      where: { ownerId: userId, approvalStatus: { not: "SUSPENDED" } },
      select: { id: true },
    }),
  ]);
  if (entitlement) blockers.push("OPEN_ENTITLEMENT");
  if (seat) blockers.push("OBSERVER_SEAT");
  if (subscription) blockers.push("SUBSCRIPTION");
  if (voucher) blockers.push("GIFT_VOUCHER");
  if (node) blockers.push("NETWORK_NODE");
  return blockers;
}

function slotEnd(slot: { slotStartAt: Date; durationMinutes: number }) {
  return new Date(slot.slotStartAt.getTime() + slot.durationMinutes * 60_000);
}

export async function deleteAccount(
  session: VerifiedSession,
  request: DeleteAccountRequest,
  now: Date = new Date(),
): Promise<{ ok: true } | Refusal> {
  const userId = session.user.id;
  // A wrong password here is a guess at the account, as on /me/password (ADR-040).
  if (!(await consumeLimit(AUTHENTICATION_POLICY, "account-deletion", userId))) {
    await recordAuthEvent("RATE_LIMITED", { userId });
    return rateLimited();
  }

  const database = getDatabase();
  const account = await database.account.findUnique({ where: { userId } });
  const currentValid = await verifyPassword(
    request.currentPassword,
    account?.passwordHash ?? dummyPasswordHash,
  );
  if (!account || !currentValid) {
    return refuse(422, "VALIDATION_FAILED", "The current password is incorrect.", {
      fields: ["currentPassword"],
    });
  }

  let outcome: { blockers: AccountDeletionBlocker[] } | { storageKeys: string[] };
  try {
    outcome = await database.$transaction(
      async (tx) => {
        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { role: true },
        });
        const blockers = await accountDeletionBlockers(tx, userId, user.role, now);
        if (blockers.length > 0) return { blockers };

        const assets = await tx.captureAsset.findMany({
          where: { capture: { userId } },
          select: { storageKey: true },
        });

        // The captures go at once (ADR-044 §1); their assets, accesses and Collection
        // entries cascade. Every link to one answers 404 from here on.
        await tx.capture.deleteMany({ where: { userId } });
        await tx.collection.deleteMany({ where: { userId } });
        await tx.missionPresence.deleteMany({ where: { userId } });
        await tx.missionParticipant.deleteMany({ where: { userId } });
        await tx.loyaltyLedgerEntry.deleteMany({ where: { userId } });
        await tx.loyaltyAccount.deleteMany({ where: { userId } });
        await tx.emailNotification.deleteMany({ where: { userId } });
        await tx.emailVerificationToken.deleteMany({ where: { userId } });
        await tx.passwordResetToken.deleteMany({ where: { userId } });
        await tx.emailChangeToken.deleteMany({ where: { userId } });
        await tx.session.deleteMany({ where: { userId } });
        await tx.account.delete({ where: { userId } });
        // Kept for accounting, but the people they were for are the buyer's to name,
        // and the buyer is gone.
        await tx.giftVoucher.updateMany({
          where: { buyerUserId: userId },
          data: { recipientEmail: null, recipientName: null, message: null },
        });
        await tx.user.update({
          where: { id: userId },
          data: {
            name: DELETED_NAME,
            email: deletedEmail(userId),
            emailVerifiedAt: null,
            deletedAt: now,
          },
        });
        // The audit log keeps the id and nothing that names the person (ADR-044 §3).
        await recordAuditEvent(
          { category: "AUTH", action: "ACCOUNT_DELETED", actorUserId: userId },
          tx,
        );

        return { storageKeys: assets.map((asset) => asset.storageKey) };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (isSerializationFailure(error)) {
      return refuse(
        409,
        "CONFLICT",
        "The account changed while it was being deleted. Try again.",
      );
    }
    throw error;
  }

  if ("blockers" in outcome) {
    return refuse(409, "CONFLICT", "The account has something to settle first.", {
      blockers: outcome.blockers,
    });
  }

  // After the commit, and best effort: a row that no longer names an object makes it
  // an orphan, and the orphan sweep (#141) removes whatever this could not.
  const storage = getStorage();
  await Promise.allSettled(
    outcome.storageKeys.map((key) => deleteObject(storage, key, new Date())),
  );
  return { ok: true };
}

function isSerializationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === "P2034") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("40001");
}
