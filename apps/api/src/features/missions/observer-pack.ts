import "server-only";

import { randomUUID } from "node:crypto";

import type {
  ErrorCode,
  ObserverPack,
  ObserverPackWithPaymentIntent,
  PaymentIntent,
} from "@darkview/contracts";
import type { Prisma } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";
import { hashVoucherCode, normaliseVoucherCode } from "@darkview/db/vouchers";

import { claimPrize, findSpendablePrize } from "@/features/cards/draw";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { paymentCheckout, paymentProvider } from "@/features/payments/bog-checkout";
import { getDatabase } from "@/lib/db/client";

/**
 * The Observer Pack sale (ADR-007, DV-102).
 *
 * DV-100 built the seat and stopped at the thing that makes one legitimate: a
 * settled payment. This is that payment, on the adapter DV-056 built, and the
 * rules it enforces come from ADR-007 rather than from here.
 *
 * The pack is the sale; `MissionParticipant` is the attachment to it. Capacity is
 * counted on packs and never on attached observers, because a seat outlives a
 * connection. An observer whose phone drops on the Tbilisi metro still owns what
 * they paid for, and a seat that went back on sale the instant they disconnected
 * would sell their session to somebody else while they walked up the escalator.
 *
 * Nothing here grants command capability, and nothing here may ever be asked to.
 * ADR-007 rule 2 is structural: the cloud mints a CommandEnvelope only for the
 * session owner and the agent independently refuses any envelope whose sessionId
 * is not the owner it last received. A bug in this file cannot reach the mount.
 */

/**
 * PROVISIONAL. In tetri, the minor unit of the Georgian lari: 1500 = 15.00 GEL.
 *
 * ADR-007 rule 6 fixes only the relation -- "an Observer Pack seat is priced below
 * a full session; the exact figure is commercial and set outside this record" --
 * and no controlling document sets the figure. This exists so the contract's
 * required `priceMinor` has a value and the payment path is exercised end to end.
 * It is not a commercial decision and must be replaced before anything is sold,
 * exactly like PROVISIONAL_SLOT_PRICE_MINOR, which a test holds it below.
 *
 * Integer minor units, never a float.
 */
export const PROVISIONAL_OBSERVER_PACK_PRICE_MINOR = 1500;

/**
 * PROVISIONAL. How long an unpaid pack holds a seat.
 *
 * Shorter than DV-055's fifteen-minute booking hold, and for a reason that is not
 * impatience: a booking holds a slot on a future night, while this holds a seat on
 * a session that is running right now. Fifteen minutes of an abandoned checkout is
 * most of somebody's observation, and the seat would come back on sale with
 * nothing left to watch.
 *
 * Revisit it against the real provider's redirect behaviour, together with
 * PAYMENT_HOLD_MINUTES.
 */
export const OBSERVER_PACK_HOLD_MINUTES = 5;

/** The pack statuses that occupy one of the mission's seats. */
const SEAT_HOLDING_STATUSES = ["PENDING_PAYMENT", "PAID"] as const;

export type ObserverPackFailure = {
  ok: false;
  status: 403 | 404 | 409 | 422 | 500;
  code: ErrorCode;
  message: string;
};

export type ObserverPackResult<T> = { ok: true; value: T } | ObserverPackFailure;

type PackRow = {
  id: string;
  missionId: string;
  userId: string;
  paymentId: string | null;
  status: string;
  holdExpiresAt: Date | null;
  priceMinor: number;
  currency: string;
  refundedMinor: number | null;
  refundOwedMinor: number | null;
  createdAt: Date;
};

const NO_SUCH_MISSION: ObserverPackFailure = {
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: "No such mission.",
};

export function toContractPack(row: PackRow): ObserverPack {
  return {
    id: row.id,
    missionId: row.missionId,
    userId: row.userId,
    status: row.status as ObserverPack["status"],
    priceMinor: row.priceMinor,
    currency: row.currency as ObserverPack["currency"],
    paymentId: row.paymentId,
    holdExpiresAt: row.holdExpiresAt?.toISOString() ?? null,
    refundedMinor: row.refundedMinor,
    // ADR-045: owed is said as owed; the database keeps the two apart.
    refundOwedMinor: row.refundOwedMinor,
    createdAt: row.createdAt.toISOString(),
  };
}

const PRIZE_UNUSABLE: ObserverPackFailure = {
  ok: false,
  status: 422,
  code: "VALIDATION_FAILED",
  message: "That voucher code cannot be used.",
};

function toPaymentIntent(
  payment: { id: string; provider: string; status: string; redirectUrl: string | null },
  expiresAt: Date | null,
): PaymentIntent {
  return {
    paymentId: payment.id,
    provider: payment.provider as PaymentIntent["provider"],
    status: payment.status as PaymentIntent["status"],
    redirectUrl: payment.redirectUrl,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  };
}

/**
 * Expire every pack on this mission whose hold has run out.
 *
 * Locked first, so several purchases arriving together do not each try to expire
 * the same rows: the losers block, re-read, and update nothing. The payment behind
 * a lapsed hold is left PENDING rather than marked FAILED -- nobody has said it
 * failed, and a capture that arrives late is still a capture the settlement path
 * has to account for. It does: a pack that is no longer PENDING_PAYMENT records
 * `OBSERVER_PACK_CAPTURED_WITHOUT_SEAT`, which is DV-111's to refund.
 */
async function expireLapsedPacks(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">,
  missionId: string,
  now: Date,
): Promise<void> {
  const lapsed = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ObserverPack"
    WHERE "missionId" = ${missionId}::uuid
      AND "status" = 'PENDING_PAYMENT'
      AND "holdExpiresAt" <= ${now}
    FOR UPDATE
  `;

  if (lapsed.length === 0) return;

  await tx.$executeRaw`
    UPDATE "ObserverPack"
    SET "status" = 'EXPIRED', "holdExpiresAt" = NULL, "updatedAt" = ${now}
    WHERE "id" = ANY(${lapsed.map((row) => row.id)}::uuid[])
  `;
}

/**
 * Buy one seat on a live session, and hold it while the payment is outstanding.
 *
 * The capacity check and the insert are one transaction over a locked mission row,
 * for the reason `takeObserverSeat` gives: "at most N rows" is not something a
 * unique index can say, so the lock says it. Counting and then inserting without
 * the lock is how a hard cap of ten becomes eleven.
 *
 * Asking twice returns the same pack rather than opening a second payment. A
 * customer who reloads a checkout page has not bought two seats, and the unique
 * index on (missionId, userId) backstops the read if two requests race.
 */
export async function purchaseObserverPack(input: {
  missionId: string;
  userId: string;
  /** ADR-060: an OBSERVER_SEAT prize code, which pays for the seat instead of money. */
  voucherCode?: string;
  now: Date;
}): Promise<ObserverPackResult<ObserverPackWithPaymentIntent>> {
  const database = getDatabase();
  const { missionId, userId, now } = input;

  let codeHash: string | null = null;
  if (input.voucherCode !== undefined) {
    const code = normaliseVoucherCode(input.voucherCode);
    if (!code) return PRIZE_UNUSABLE;
    codeHash = hashVoucherCode(code);
  }

  if (!paymentProvider()) {
    return {
      ok: false,
      status: 500,
      code: "INTERNAL",
      message: "Observer Packs are unavailable: no payment provider is configured.",
    };
  }

  try {
    return await purchaseInTransaction(database, { missionId, userId, codeHash, now });
  } catch (error) {
    if (error instanceof PrizeAlreadySpent) return PRIZE_UNUSABLE;
    throw error;
  }
}

async function purchaseInTransaction(
  database: ReturnType<typeof getDatabase>,
  input: { missionId: string; userId: string; codeHash: string | null; now: Date },
): Promise<ObserverPackResult<ObserverPackWithPaymentIntent>> {
  const { missionId, userId, codeHash, now } = input;
  return database.$transaction(async (tx) => {
    // FOR UPDATE, so concurrent purchases on one mission queue behind each other.
    const rows = await tx.$queryRaw<
      {
        userId: string;
        state: string;
        joinPolicy: string;
        observerCapacity: number;
        isDemo: boolean;
        observatoryId: string;
      }[]
    >`
      SELECT "userId", "state"::text AS state, "joinPolicy"::text AS "joinPolicy",
             "observerCapacity", "isDemo", "observatoryId"
      FROM "Mission" WHERE "id" = ${missionId}::uuid FOR UPDATE
    `;

    const mission = rows[0];
    if (!mission) return NO_SUCH_MISSION;

    // The controller holds the session already; selling them a seat on it would
    // take one from somebody who could have watched.
    if (mission.userId === userId) {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: "The controller of a session cannot also observe it.",
      } satisfies ObserverPackFailure;
    }

    if (
      !LIVE_MISSION_STATES.includes(mission.state as (typeof LIVE_MISSION_STATES)[number])
    ) {
      return {
        ok: false,
        status: 409,
        code: "MISSION_NOT_ACTIVE",
        message: `A mission in ${mission.state} has nothing to observe.`,
      } satisfies ObserverPackFailure;
    }

    // ADR-007 rule 5: private by default. Selling a seat on a session whose owner
    // has not opted in would take money for something that cannot be delivered.
    if (mission.joinPolicy !== "OPEN") {
      return {
        ok: false,
        status: 403,
        code: "MISSION_NOT_OBSERVABLE",
        message: "The controller has not opened this session to observers.",
      } satisfies ObserverPackFailure;
    }

    await expireLapsedPacks(tx, missionId, now);

    const existing = await tx.observerPack.findUnique({
      where: { missionId_userId: { missionId, userId } },
      include: { payment: true },
    });

    // Already paid for by a prize: the seat stands, and a code sent again spends nothing.
    if (existing && existing.status === "PAID" && !existing.payment) {
      return {
        ok: true,
        value: { observerPack: toContractPack(existing), paymentIntent: null },
      };
    }

    // Already bought, or already holding. Either way this is the same seat and the
    // same payment, not a second one. A prize offered for a seat already held awaiting
    // payment is refused rather than racing the payment it would replace.
    if (codeHash !== null && existing?.status === "PENDING_PAYMENT" && existing.payment) {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: "This seat is already held awaiting payment.",
      } satisfies ObserverPackFailure;
    }
    if (
      existing &&
      SEAT_HOLDING_STATUSES.includes(
        existing.status as (typeof SEAT_HOLDING_STATUSES)[number],
      ) &&
      existing.payment
    ) {
      return {
        ok: true,
        value: {
          observerPack: toContractPack(existing),
          paymentIntent: toPaymentIntent(existing.payment, existing.holdExpiresAt),
        },
      };
    }

    const held = await tx.observerPack.count({
      where: { missionId, status: { in: [...SEAT_HOLDING_STATUSES] } },
    });

    if (held >= mission.observerCapacity) {
      return {
        ok: false,
        status: 409,
        code: "OBSERVER_CAPACITY_REACHED",
        message: `All ${mission.observerCapacity} observer seats are taken.`,
      } satisfies ObserverPackFailure;
    }

    if (codeHash !== null) {
      const prize = await findSpendablePrize(tx, { codeHash, userId, now });
      if (
        !prize ||
        prize.kind !== "OBSERVER_SEAT" ||
        prize.observatoryId !== mission.observatoryId
      ) {
        return PRIZE_UNUSABLE;
      }
      return seatPaidByPrize(tx, {
        missionId,
        userId,
        existingPackId: existing?.id ?? null,
        prizeId: prize.id,
        isDemo: mission.isDemo,
        seatsHeld: held + 1,
        capacity: mission.observerCapacity,
        now,
      });
    }

    // #170. The sandbox is its own provider, so the cloud supplies the redirect, as
    // `createBooking` does: a checkout page it serves, keyed by this payment's id.
    const paymentId = randomUUID();
    const payment = await tx.payment.create({
      data: {
        id: paymentId,
        userId,
        purpose: "OBSERVER_PACK",
        ...paymentCheckout(paymentId),
        status: "PENDING",
        amountMinor: PROVISIONAL_OBSERVER_PACK_PRICE_MINOR,
        currency: "GEL",
        isDemo: mission.isDemo,
      },
    });

    const holdExpiresAt = new Date(now.getTime() + OBSERVER_PACK_HOLD_MINUTES * 60_000);

    // A pack that lapsed or was cancelled is bought again on the same row: the
    // unique index allows one per person per mission, and a second attempt after a
    // failed payment is a customer trying again, not a second seat.
    const pack = existing
      ? await tx.observerPack.update({
          where: { id: existing.id },
          data: {
            paymentId: payment.id,
            status: "PENDING_PAYMENT",
            holdExpiresAt,
            priceMinor: PROVISIONAL_OBSERVER_PACK_PRICE_MINOR,
            currency: "GEL",
            paidAt: null,
          },
        })
      : await tx.observerPack.create({
          data: {
            missionId,
            userId,
            paymentId: payment.id,
            status: "PENDING_PAYMENT",
            holdExpiresAt,
            priceMinor: PROVISIONAL_OBSERVER_PACK_PRICE_MINOR,
            currency: "GEL",
            isDemo: mission.isDemo,
          },
        });

    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "OBSERVER_PACK_RESERVED",
        actorUserId: userId,
        missionId,
        entityType: "ObserverPack",
        entityId: pack.id,
        detail: {
          paymentId: payment.id,
          priceMinor: PROVISIONAL_OBSERVER_PACK_PRICE_MINOR,
          currency: "GEL",
          holdExpiresAt: holdExpiresAt.toISOString(),
          seatsHeld: held + 1,
          capacity: mission.observerCapacity,
        },
        isDemo: mission.isDemo,
      },
      tx,
    );

    return {
      ok: true,
      value: {
        observerPack: toContractPack(pack as PackRow),
        paymentIntent: toPaymentIntent(payment, holdExpiresAt),
      },
    };
  });
}

/**
 * A seat an OBSERVER_SEAT prize pays for (ADR-060): PAID at once, at no price, with no
 * payment. Inside the purchase's transaction and under its mission lock, so the seat
 * counts against the cap exactly as a sold one does, and the prize is spent by a
 * conditional update a racing spend cannot also win.
 */
async function seatPaidByPrize(
  tx: Prisma.TransactionClient,
  input: {
    missionId: string;
    userId: string;
    existingPackId: string | null;
    prizeId: string;
    isDemo: boolean;
    seatsHeld: number;
    capacity: number;
    now: Date;
  },
): Promise<ObserverPackResult<ObserverPackWithPaymentIntent>> {
  const { missionId, userId, prizeId, now } = input;
  const data = {
    paymentId: null,
    status: "PAID" as const,
    holdExpiresAt: null,
    priceMinor: 0,
    currency: "GEL" as const,
    paidAt: now,
  };
  const pack = input.existingPackId
    ? await tx.observerPack.update({ where: { id: input.existingPackId }, data })
    : await tx.observerPack.create({
        data: { ...data, missionId, userId, isDemo: input.isDemo },
      });

  if (!(await claimPrize(tx, { prizeId, userId, now, observerPackId: pack.id }))) {
    throw new PrizeAlreadySpent();
  }

  await recordAuditEvent(
    {
      category: "CARD_DRAW",
      action: "CARD_PRIZE_REDEEMED",
      actorUserId: userId,
      missionId,
      entityType: "CardPrize",
      entityId: prizeId,
      detail: {
        observerPackId: pack.id,
        kind: "OBSERVER_SEAT",
        seatsHeld: input.seatsHeld,
        capacity: input.capacity,
      },
      isDemo: input.isDemo,
    },
    tx,
  );

  return {
    ok: true,
    value: { observerPack: toContractPack(pack as PackRow), paymentIntent: null },
  };
}

/** Thrown inside the transaction when a racing spend took the prize, so the seat rolls back. */
class PrizeAlreadySpent extends Error {}

/**
 * Whether this person holds a paid seat on this mission.
 *
 * The gate `takeObserverSeat` asks before attaching anybody. It reads PAID and
 * nothing else: a hold is a seat somebody is holding, not a seat somebody owns.
 */
export async function hasPaidObserverPack(
  tx: Pick<Prisma.TransactionClient, "observerPack">,
  missionId: string,
  userId: string,
): Promise<boolean> {
  const pack = await tx.observerPack.findUnique({
    where: { missionId_userId: { missionId, userId } },
    select: { status: true },
  });

  return pack?.status === "PAID";
}
