import { recordAuditEvent } from "./audit";
import type { Prisma } from "./generated/prisma/client.ts";
import type { CreditLedgerReason } from "./generated/prisma/enums.ts";

/**
 * Darkview's credit ledger (ADR-022, issue #95).
 *
 * A credit is **one minute of sky**, not one observation: the slot length is not
 * settled until DV-035 measures the real optical train, and a plan denominated in
 * observations would change value underneath a customer who already bought one.
 *
 * Shared because the API spends minutes at reservation and releases them on a
 * refund, and the realtime service grants them when a renewal settles.
 *
 * **Append-only, idempotent by source.** Every change is a new entry, unique on
 * `idempotencyKey`, which names what caused it:
 *
 * - `renewal:<subscriptionId>:<periodStart>`
 * - `booking:<bookingId>` and `booking:<bookingId>:release`
 * - `expiry:<subscriptionId>:<periodEnd>`
 * - `admin:<auditEventId>`
 *
 * Because the key names the period rather than the attempt, a webhook delivered
 * twice, a sweep that ran on two processes and a retried charge all converge on one
 * grant. The entry is inserted with ON CONFLICT DO NOTHING and the account moves
 * only when a row was actually written, so a repeat changes nothing -- and never
 * aborts the caller's transaction the way a unique violation would.
 *
 * **Minutes are not money and not points.** A credit is never refunded as cash, and
 * spending one earns no loyalty points, because no money moved (ADR-008, ADR-022
 * section 3).
 *
 * Pass the transaction client: the entry, the account and the audit row share the
 * fate of whatever caused them.
 */

type Tx = Prisma.TransactionClient;

/** The user's credit account, created at zero the first time it is needed. */
export async function ensureCreditAccount(tx: Tx, userId: string) {
  await tx.creditAccount.createMany({ data: [{ userId }], skipDuplicates: true });
  return tx.creditAccount.findUniqueOrThrow({ where: { userId } });
}

export type CreditEntry = {
  userId: string;
  /** Signed, in observation minutes. Negative spends. */
  amount: number;
  reason: CreditLedgerReason;
  /** Names the source event, by the conventions above. */
  idempotencyKey: string;
  missionId?: string | null;
  note?: string | null;
  /** Recorded on the audit row. CreditLedger itself carries no actor. */
  actorUserId?: string | null;
  isDemo?: boolean;
};

export type CreditPostResult =
  | { posted: true; balance: number }
  | { posted: false; reason: "DUPLICATE" | "INSUFFICIENT_CREDITS" };

/**
 * Append one entry and move the balance with it.
 *
 * A spend is claimed with a conditional update on the balance before the entry is
 * written, so two spends racing on one balance cannot both succeed, and checkout
 * does not serialise on a row lock.
 */
export async function postCreditEntry(
  tx: Tx,
  entry: CreditEntry,
): Promise<CreditPostResult> {
  if (entry.reason === "PRIVATE_SESSION_DEBIT") {
    // ADR-022 section 1: unfrozen as a name, so the enum needs no migration when
    // private sessions arrive. Nothing in Phase 1 may write it.
    throw new Error("PRIVATE_SESSION_DEBIT is not written in Phase 1 (ADR-022).");
  }
  if (!Number.isSafeInteger(entry.amount)) {
    throw new Error("A credit entry moves a whole number of minutes.");
  }

  await ensureCreditAccount(tx, entry.userId);

  const already = await tx.creditLedger.findUnique({
    where: { idempotencyKey: entry.idempotencyKey },
    select: { id: true },
  });
  if (already) return { posted: false, reason: "DUPLICATE" };

  if (entry.amount < 0) {
    const { count } = await tx.creditAccount.updateMany({
      where: { userId: entry.userId, balance: { gte: -entry.amount } },
      data: { balance: { increment: entry.amount } },
    });
    if (count === 0) return { posted: false, reason: "INSUFFICIENT_CREDITS" };
  } else if (entry.amount > 0) {
    await tx.creditAccount.update({
      where: { userId: entry.userId },
      data: { balance: { increment: entry.amount } },
    });
  }

  // Our own update holds the row until this transaction commits, so this is the
  // balance the entry actually produced.
  const account = await tx.creditAccount.findUniqueOrThrow({
    where: { userId: entry.userId },
  });

  const { count } = await tx.creditLedger.createMany({
    data: [
      {
        userId: entry.userId,
        missionId: entry.missionId ?? null,
        amount: entry.amount,
        balanceAfter: account.balance,
        reason: entry.reason,
        idempotencyKey: entry.idempotencyKey,
        note: entry.note ?? null,
        isDemo: entry.isDemo ?? false,
      },
    ],
    skipDuplicates: true,
  });
  // A concurrent writer recorded the same event between the read and the insert.
  // Its account change stands; this one must not.
  if (count === 0) {
    await tx.creditAccount.update({
      where: { userId: entry.userId },
      data: { balance: { increment: -entry.amount } },
    });
    return { posted: false, reason: "DUPLICATE" };
  }

  await recordAuditEvent(
    {
      category: "SUBSCRIPTION",
      action: `CREDIT_${entry.reason}`,
      actorUserId: entry.actorUserId ?? null,
      entityType: "CreditAccount",
      entityId: entry.userId,
      detail: {
        amount: entry.amount,
        reason: entry.reason,
        idempotencyKey: entry.idempotencyKey,
        missionId: entry.missionId ?? null,
        note: entry.note ?? null,
        balanceAfter: account.balance,
      },
    },
    tx,
  );

  return { posted: true, balance: account.balance };
}

/** What a booking may spend. Zero when the customer has never had a credit. */
export async function readCreditBalance(
  reader: Pick<Tx, "creditAccount">,
  userId: string,
): Promise<number> {
  const account = await reader.creditAccount.findUnique({ where: { userId } });
  return account?.balance ?? 0;
}

export type BookingSpendResult =
  | { spent: true }
  | { spent: false; reason: "NO_CURRENT_PERIOD" | "INSUFFICIENT_CREDITS" | "DUPLICATE" };

/**
 * Take the minutes a booking costs (ADR-022 section 7), inside the reservation's
 * transaction and after the booking row exists, so a slot conflict rolls the spend
 * back with it.
 *
 * Minutes are spendable while the subscription is ACTIVE or PAUSED and its period
 * has not ended: a pause stops charging and granting, not spending (maintainer
 * decision of 2026-09-19). A period that has ended spends nothing even before its
 * expiry entry is written, because those minutes are already gone.
 *
 * **Open, and deliberately left alone:** a capture that settles against a
 * subscription the customer has already CANCELLED grants that period's minutes
 * (`subscriptions.ts`, "ADR-022 gives them the minutes it bought"), and this
 * function will not let them be spent. One of the two is wrong -- either the grant
 * should not happen, or CANCELLED should keep spending until the period it paid for
 * ends -- and which is a product decision, not an implementation one. ADR-022
 * section 9 calls cancellation "immediate", which is why this side was not changed.
 * See `ledger.integration.test.ts`.
 */
export async function spendBookingMinutes(
  tx: Tx,
  booking: { id: string; userId: string; minutes: number; isDemo: boolean },
  now: Date,
): Promise<BookingSpendResult> {
  const subscription = await tx.subscription.findUnique({
    where: { userId: booking.userId },
    select: { status: true, currentPeriodEnd: true },
  });
  if (
    !subscription ||
    (subscription.status !== "ACTIVE" && subscription.status !== "PAUSED") ||
    !subscription.currentPeriodEnd ||
    subscription.currentPeriodEnd <= now
  ) {
    return { spent: false, reason: "NO_CURRENT_PERIOD" };
  }

  const result = await postCreditEntry(tx, {
    userId: booking.userId,
    amount: -booking.minutes,
    reason: "MISSION_DEBIT",
    idempotencyKey: `booking:${booking.id}`,
    actorUserId: booking.userId,
    isDemo: booking.isDemo,
  });
  return result.posted ? { spent: true } : { spent: false, reason: result.reason };
}

/** Whether this customer has a period that has been paid for and has not ended. */
async function hasRunningPeriod(tx: Tx, userId: string, now: Date): Promise<boolean> {
  const subscription = await tx.subscription.findUnique({
    where: { userId },
    select: { currentPeriodEnd: true },
  });
  return Boolean(subscription?.currentPeriodEnd && subscription.currentPeriodEnd > now);
}

/**
 * Give back the minutes a booking spent, when the booking did not happen. One entry
 * per booking however many release paths reach it, beside `releaseRedeemedPoints`.
 * A credit is returned as a credit, never as money.
 *
 * **Nothing comes back after the period has ended.** Minutes do not roll over; they
 * expire at period end (ADR-022, amended 2026-09-19), and the expiry entry is keyed
 * to that end, so a later pass of the sweep writes nothing. Without this test the
 * automatic refund of an unflown booking -- which runs thirty days later, long after
 * the period it belonged to -- put minutes back into a dead period and left them
 * there permanently, spendable against a month nobody paid for.
 *
 * Minutes released during a *later* funded period do land in that period. They are
 * bounded by what was spent and they expire with it, and the alternative is
 * recording which period every booking's minutes came from for a distinction the
 * customer would experience as their refund vanishing.
 */
export async function releaseSpentMinutes(
  tx: Tx,
  booking: { id: string; userId: string; subscriptionMinutesSpent: number },
  now: Date,
): Promise<void> {
  if (booking.subscriptionMinutesSpent <= 0) return;
  if (!(await hasRunningPeriod(tx, booking.userId, now))) return;
  await postCreditEntry(tx, {
    userId: booking.userId,
    amount: booking.subscriptionMinutesSpent,
    reason: "REFUND",
    idempotencyKey: `booking:${booking.id}:release`,
  });
}

/**
 * Take back what a period left unspent, at its end (ADR-022, and the maintainer's
 * decision of 2026-09-19: minutes do not roll over). Written by the renewal sweep
 * before it charges the next period, so the next grant is never what expires.
 *
 * The whole balance goes, keyed to the period's end so a second pass writes
 * nothing. A balance of zero writes no entry.
 */
export async function expireSubscriptionMinutes(
  tx: Tx,
  subscription: { id: string; userId: string; isDemo: boolean },
  periodEnd: Date,
): Promise<CreditPostResult | null> {
  const balance = await readCreditBalance(tx, subscription.userId);
  if (balance <= 0) return null;
  return postCreditEntry(tx, {
    userId: subscription.userId,
    amount: -balance,
    reason: "EXPIRY",
    idempotencyKey: `expiry:${subscription.id}:${periodEnd.toISOString()}`,
    isDemo: subscription.isDemo,
  });
}

/**
 * Grant a period's minutes. Written inside the settlement transaction, on capture:
 * there is no path that grants before money arrives (ADR-022 section 6).
 */
export async function grantSubscriptionMinutes(
  tx: Tx,
  subscription: { id: string; userId: string; isDemo: boolean },
  periodStart: Date,
  minutes: number,
): Promise<CreditPostResult> {
  return postCreditEntry(tx, {
    userId: subscription.userId,
    amount: minutes,
    reason: "SUBSCRIPTION_GRANT",
    idempotencyKey: `renewal:${subscription.id}:${periodStart.toISOString()}`,
    isDemo: subscription.isDemo,
  });
}
