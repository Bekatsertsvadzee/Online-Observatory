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
