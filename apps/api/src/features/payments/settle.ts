import "server-only";

import type { ErrorCode, PaymentProvider } from "@darkview/contracts";
import type { Prisma } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";
import { queueEmail } from "@darkview/db/notifications";

import { releaseHeldSlot } from "@/features/booking/reserve";
import { TERMINAL_MISSION_STATES } from "@/features/missions/session";
import type { PaymentOutcome } from "@/features/payments/provider";
import { getDatabase } from "@/lib/db/client";

export type SettlementFailure = {
  ok: false;
  status: 400;
  code: ErrorCode;
  message: string;
};

export type SettlementSuccess = {
  ok: true;
  /** False when the callback repeated one already applied and changed nothing. */
  applied: boolean;
  /** The mission a captured payment scheduled, when it scheduled one. */
  missionId: string | null;
};

export type SettlementResult = SettlementSuccess | SettlementFailure;

type Locked = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Apply a verified provider outcome to Darkview's own Payment record, and to
 * whatever that payment bought.
 *
 * Two things are for sale: a slot, which becomes a booking and a mission, and an
 * Observer Pack seat on somebody else's session (ADR-007). `Payment.purpose` says
 * which, and it is read rather than inferred from whichever relation is null --
 * a payment with neither attached would otherwise be settled as a booking whose
 * row had vanished.
 *
 * Signature verification has already happened; this trusts `outcome` to be what
 * the provider said and checks only whether what it said fits the records. The
 * checks are the ones the contract asks for -- "normalises the result and only
 * then confirms the booking and creates the mission" -- plus one it does not
 * spell out: the callback's amount must equal the intent's. A provider that
 * reports a smaller capture than the price was quoted at has not paid for the
 * slot, whatever its status field says.
 *
 * Idempotent by (provider, providerRef). A provider retries until it sees 2xx,
 * so the same capture arrives more than once, and the second arrival must
 * neither fail nor schedule a second mission. A callback that names an
 * already-settled payment with a *different* outcome is refused: two answers
 * about one payment is a provider fault, and picking the later one would let a
 * replayed FAILED unwind a mission.
 *
 * The payment row is locked first, then the booking. Two callbacks for one
 * payment serialise on the payment lock; a reservation sweeping lapsed holds
 * (`expireLapsedHolds`) locks booking rows only, so the two never wait on each
 * other in opposite orders.
 */
export async function settlePayment(input: {
  provider: PaymentProvider;
  outcome: PaymentOutcome;
  now: Date;
}): Promise<SettlementResult> {
  const database = getDatabase();
  const { provider, outcome, now } = input;

  const refused = (message: string, detail: Record<string, unknown>) =>
    refuse(database, provider, outcome, message, detail);

  return database.$transaction(async (tx) => {
    await lockPayment(tx, outcome.paymentId);

    const payment = await tx.payment.findUnique({
      where: { id: outcome.paymentId },
      include: {
        booking: { select: { id: true, missionId: true } },
        observerPack: { select: { id: true, missionId: true } },
      },
    });

    if (!payment) {
      return refused("No such payment.", { reason: "UNKNOWN_PAYMENT" });
    }

    if (payment.provider !== provider) {
      return refused("The payment was not opened with that provider.", {
        reason: "PROVIDER_MISMATCH",
        expectedProvider: payment.provider,
      });
    }

    if (payment.amountMinor !== outcome.amountMinor || payment.currency !== outcome.currency) {
      return refused("The callback's amount does not match the payment intent.", {
        reason: "AMOUNT_MISMATCH",
        expectedAmountMinor: payment.amountMinor,
        expectedCurrency: payment.currency,
        reportedAmountMinor: outcome.amountMinor,
        reportedCurrency: outcome.currency,
      });
    }

    if (payment.status === "CAPTURED" || payment.status === "FAILED") {
      if (payment.providerRef === outcome.providerRef && payment.status === outcome.result) {
        return {
          ok: true,
          applied: false,
          missionId: payment.observerPack?.missionId ?? payment.booking?.missionId ?? null,
        };
      }

      return refused("The payment has already been settled with a different outcome.", {
        reason: "ALREADY_SETTLED",
        settledStatus: payment.status,
      });
    }

    if (payment.status === "REFUNDED") {
      return refused("The payment has already been refunded.", {
        reason: "ALREADY_SETTLED",
        settledStatus: payment.status,
      });
    }

    // A ref this provider has used for a different payment is a provider fault
    // and lands here as the unique index on (provider, providerRef).
    const taken = await tx.payment.findUnique({
      where: { provider_providerRef: { provider, providerRef: outcome.providerRef } },
      select: { id: true },
    });
    if (taken && taken.id !== payment.id) {
      return refused("That provider reference already belongs to another payment.", {
        reason: "PROVIDER_REF_REUSED",
      });
    }

    // An Observer Pack is a different sale with a different subject, so it takes a
    // different path from here. The checks above are the ones every payment gets
    // -- it exists, it is this provider's, it is for this sum, it has not already
    // been answered -- and they do not care what was bought.
    if (payment.purpose === "OBSERVER_PACK") {
      return settleObserverPackPayment(tx, payment, outcome, now);
    }

    // Locked after the read that found it, so read again: a reservation sweeping
    // lapsed holds may have expired this booking between the two, and the status
    // that decides whether a mission is created has to be the one under the lock.
    const booking = payment.booking ? await lockBooking(tx, payment.booking.id) : null;

    if (outcome.result === "FAILED") {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "FAILED",
          providerRef: outcome.providerRef,
          failureReason: outcome.failureReason,
        },
      });

      if (booking) {
        await releaseHeldSlot(tx, booking, outcome.failureReason ?? "PAYMENT_FAILED");
      }

      await recordAuditEvent(
        {
          category: "PAYMENT",
          action: "PAYMENT_FAILED",
          actorUserId: payment.userId,
          entityType: "Payment",
          entityId: payment.id,
          detail: {
            provider,
            providerRef: outcome.providerRef,
            bookingId: booking?.id ?? null,
            failureReason: outcome.failureReason,
          },
          isDemo: payment.isDemo,
        },
        tx,
      );

      return { ok: true, applied: true, missionId: null };
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "CAPTURED",
        providerRef: outcome.providerRef,
        capturedAt: now,
      },
    });

    // The customer paid, and there is nothing to confirm: the hold lapsed and a
    // reservation sweep expired it, or they cancelled while the bank was still
    // thinking. The money moved, so the payment is recorded as captured -- the
    // record says what happened -- and the row below is what the refund engine
    // (DV-111) works from. Nothing here refunds, because nothing here can yet.
    //
    // A hold that lapsed but was not swept is *not* this case: the booking is
    // still PENDING_PAYMENT, still in the exclusion constraint, and nobody else
    // holds the slot, so it is confirmed like any other. Being late to pay only
    // costs the customer the slot if somebody else took it first.
    if (!booking || booking.status !== "PENDING_PAYMENT" || booking.missionId) {
      await recordAuditEvent(
        {
          category: "PAYMENT",
          action: "PAYMENT_CAPTURED_WITHOUT_SLOT",
          actorUserId: payment.userId,
          entityType: "Payment",
          entityId: payment.id,
          detail: {
            provider,
            providerRef: outcome.providerRef,
            amountMinor: outcome.amountMinor,
            currency: outcome.currency,
            bookingId: booking?.id ?? null,
            bookingStatus: booking?.status ?? null,
          },
          isDemo: payment.isDemo,
        },
        tx,
      );

      return { ok: true, applied: true, missionId: booking?.missionId ?? null };
    }

    // ADR-004: a mission is born REQUESTED and becomes SCHEDULED. A booked
    // mission has its instant from the moment it exists, so it is written in
    // SCHEDULED directly; the event row is the transition. `mode` is the
    // observatory's, copied at creation so a mission run against the simulator
    // stays marked SIMULATED whatever the observatory is switched to later.
    const mission = await tx.mission.create({
      data: {
        userId: booking.userId,
        targetId: booking.targetId,
        observatoryId: booking.observatoryId,
        telescopeId: booking.telescopeId,
        state: "SCHEDULED",
        mode: booking.observatory.mode,
        isDemo: booking.isDemo,
        requestedAt: now,
        scheduledFor: booking.slotStartAt,
      },
    });

    await tx.missionEvent.create({
      data: {
        missionId: mission.id,
        state: "SCHEDULED",
        source: "CLOUD",
        message: "Payment captured; mission scheduled for the booked slot.",
        occurredAt: now,
        simulated: booking.observatory.mode === "SIMULATED",
        isDemo: booking.isDemo,
      },
    });

    await tx.booking.update({
      where: { id: booking.id },
      data: { status: "CONFIRMED", missionId: mission.id },
    });

    // DV-064. In this transaction, so a confirmation that rolls back emails nobody.
    await queueEmail(tx, {
      userId: booking.userId,
      kind: "BOOKING_CONFIRMED",
      dedupeKey: `booking-confirmed:${booking.id}`,
      payload: { bookingId: booking.id },
    });

    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "PAYMENT_CAPTURED",
        actorUserId: payment.userId,
        missionId: mission.id,
        entityType: "Payment",
        entityId: payment.id,
        detail: {
          provider,
          providerRef: outcome.providerRef,
          amountMinor: outcome.amountMinor,
          currency: outcome.currency,
          bookingId: booking.id,
        },
        isDemo: payment.isDemo,
      },
      tx,
    );

    await recordAuditEvent(
      {
        category: "MISSION",
        action: "MISSION_SCHEDULED",
        actorUserId: payment.userId,
        missionId: mission.id,
        entityType: "Booking",
        entityId: booking.id,
        detail: {
          observatoryId: booking.observatoryId,
          targetId: booking.targetId,
          scheduledFor: booking.slotStartAt.toISOString(),
          durationMinutes: booking.durationMinutes,
          paymentId: payment.id,
        },
        isDemo: payment.isDemo,
      },
      tx,
    );

    return { ok: true, applied: true, missionId: mission.id };
  });
}

/**
 * Apply a verified outcome to an Observer Pack (ADR-007, DV-102).
 *
 * The seat is not attached here. Settlement makes the pack PAID and stops;
 * `POST /missions/{missionId}/observers` is what attaches, and it is the customer
 * who decides when. Marking somebody JOINED because their bank answered would put
 * a person in a session they may not have open, and DV-103 fans telemetry out to
 * exactly that collection.
 *
 * Lock order is payment, then mission, then pack -- the same mission-before-pack
 * order `purchaseObserverPack` takes, so the two never wait on each other in
 * opposite directions.
 *
 * Both branches re-read the pack under that lock and both re-check that it is
 * still *this payment's* pack, because the relation read before the lock can go
 * stale: a customer whose hold lapsed buys again on the same row with a new
 * payment, and this callback then holds a reference to a pack that has moved on.
 * Neither branch may touch it in that case -- a capture would settle somebody
 * else's outstanding checkout, and a failure would cancel a hold they are still
 * paying for.
 */
async function settleObserverPackPayment(
  tx: Prisma.TransactionClient,
  payment: {
    id: string;
    userId: string;
    isDemo: boolean;
    provider: PaymentProvider;
    observerPack: { id: string; missionId: string } | null;
  },
  outcome: PaymentOutcome,
  now: Date,
): Promise<SettlementResult> {
  const { provider } = payment;
  const missionId = payment.observerPack?.missionId ?? null;

  // Null whenever there is no pack this payment still owns: never had one, or it
  // was bought again on a newer payment while this callback was in flight.
  const owned = payment.observerPack
    ? await lockOwnedPack(tx, payment.observerPack, payment.id)
    : null;

  /** Where a row goes when the pack is not ours to name. */
  const subject = owned
    ? { entityType: "ObserverPack", entityId: owned.pack.id }
    : { entityType: "Payment", entityId: payment.id };

  if (outcome.result === "FAILED") {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        providerRef: outcome.providerRef,
        failureReason: outcome.failureReason,
      },
    });

    // The seat goes back on sale in the same transaction, the way a failed
    // booking payment releases its slot. There is no exclusion constraint to
    // leave here -- capacity is a count -- so the status change is the release.
    const released = owned?.pack.status === "PENDING_PAYMENT";
    if (released) {
      await tx.observerPack.update({
        where: { id: owned.pack.id },
        data: { status: "CANCELLED", holdExpiresAt: null },
      });
    }

    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "OBSERVER_PACK_PAYMENT_FAILED",
        actorUserId: payment.userId,
        missionId,
        ...subject,
        detail: {
          provider,
          providerRef: outcome.providerRef,
          paymentId: payment.id,
          failureReason: outcome.failureReason,
          // False when this callback arrived for a checkout the customer had
          // already replaced. Nothing was released, and the row says so rather
          // than implying a seat changed hands.
          seatReleased: released,
        },
        isDemo: payment.isDemo,
      },
      tx,
    );

    return { ok: true, applied: true, missionId: null };
  }

  await tx.payment.update({
    where: { id: payment.id },
    data: { status: "CAPTURED", providerRef: outcome.providerRef, capturedAt: now },
  });

  const seated = owned ? await seatCapturedPack(tx, owned, now) : null;

  if (!seated) {
    // The money moved and there is no seat to give for it: the pack was bought
    // again on a newer payment, the mission has ended, or the hold lapsed and the
    // session filled up while the bank was thinking. The payment is still
    // recorded CAPTURED -- the record says what happened -- and this row is what
    // the refund engine (DV-111) works from. Nothing here refunds, because
    // nothing here can yet.
    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "OBSERVER_PACK_CAPTURED_WITHOUT_SEAT",
        actorUserId: payment.userId,
        missionId,
        ...subject,
        detail: {
          provider,
          providerRef: outcome.providerRef,
          paymentId: payment.id,
          amountMinor: outcome.amountMinor,
          currency: outcome.currency,
          reason: undeliverableReason(owned),
        },
        isDemo: payment.isDemo,
      },
      tx,
    );

    return { ok: true, applied: true, missionId };
  }

  await recordAuditEvent(
    {
      category: "PAYMENT",
      action: "OBSERVER_PACK_CAPTURED",
      actorUserId: payment.userId,
      missionId: seated.missionId,
      entityType: "ObserverPack",
      entityId: seated.id,
      detail: {
        provider,
        providerRef: outcome.providerRef,
        paymentId: payment.id,
        amountMinor: outcome.amountMinor,
        currency: outcome.currency,
      },
      isDemo: payment.isDemo,
    },
    tx,
  );

  return { ok: true, applied: true, missionId: seated.missionId };
}

type OwnedPack = {
  pack: { id: string; missionId: string; status: string };
  mission: { state: string; observerCapacity: number };
};

/**
 * Lock the mission and then the pack, and hand it back only if it still belongs
 * to this payment.
 *
 * The ownership test is the point. `Payment.observerPack` was read before any
 * lock was held, and between that read and this one the customer's lapsed hold
 * may have been bought again: same pack row, new payment, PENDING_PAYMENT once
 * more. Acting on it then would apply this callback's outcome to a checkout it
 * did not pay for.
 *
 * The mission comes back with it because deliverability is decided under the same
 * lock, and locking the mission is also what serialises this against a purchase
 * counting seats.
 */
async function lockOwnedPack(
  tx: Prisma.TransactionClient,
  reference: { id: string; missionId: string },
  paymentId: string,
): Promise<OwnedPack | null> {
  const missions = await tx.$queryRaw<{ state: string; observerCapacity: number }[]>`
    SELECT "state"::text AS state, "observerCapacity"
    FROM "Mission" WHERE "id" = ${reference.missionId}::uuid FOR UPDATE
  `;
  const mission = missions[0];
  if (!mission) return null;

  await tx.$queryRaw`
    SELECT "id" FROM "ObserverPack" WHERE "id" = ${reference.id}::uuid FOR UPDATE
  `;

  const pack = await tx.observerPack.findUnique({
    where: { id: reference.id },
    select: { id: true, missionId: true, status: true, paymentId: true },
  });

  if (!pack || pack.paymentId !== paymentId) return null;

  return { pack: { id: pack.id, missionId: pack.missionId, status: pack.status }, mission };
}

/** Why a captured payment got no seat, for the row DV-111 reads. */
function undeliverableReason(owned: OwnedPack | null): string {
  if (!owned) return "PACK_NOT_OWNED_BY_PAYMENT";
  if (isTerminal(owned.mission.state)) return "MISSION_ENDED";
  return "SEAT_TAKEN_AFTER_HOLD_LAPSED";
}

function isTerminal(state: string): boolean {
  return (TERMINAL_MISSION_STATES as readonly string[]).includes(state);
}

/**
 * Give a captured pack its seat, if there is still a seat to give.
 *
 * Three things can mean there is not, and each is checked under the lock the
 * caller already holds:
 *
 * **The mission has ended.** A seat on a finished session is undeliverable and
 * always will be -- `takeObserverSeat` refuses a mission that is not live -- so
 * awarding one would take money for something nobody can ever use. Only the
 * terminal states count: a mission on weather hold is waiting, not over, and
 * refunding somebody whose session resumes twenty minutes later would be wrong.
 *
 * **The session filled up.** A pack that is still PENDING_PAYMENT never stopped
 * holding its seat, so it is simply paid for. A pack whose hold lapsed is the
 * DV-056 judgement again: being late costs the customer the seat only if somebody
 * else took it.
 *
 * **It is already PAID.** A repeated callback, and idempotent.
 */
async function seatCapturedPack(
  tx: Prisma.TransactionClient,
  owned: OwnedPack,
  now: Date,
): Promise<{ id: string; missionId: string } | null> {
  const { pack, mission } = owned;

  if (pack.status === "PAID") return { id: pack.id, missionId: pack.missionId };

  if (isTerminal(mission.state)) return null;

  if (pack.status !== "PENDING_PAYMENT") {
    const held = await tx.observerPack.count({
      where: { missionId: pack.missionId, status: { in: ["PENDING_PAYMENT", "PAID"] } },
    });
    if (held >= mission.observerCapacity) return null;
  }

  return tx.observerPack.update({
    where: { id: pack.id },
    data: { status: "PAID", paidAt: now, holdExpiresAt: null },
    select: { id: true, missionId: true },
  });
}

async function lockPayment(tx: Locked, paymentId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId}::uuid FOR UPDATE`;
}

async function lockBooking(tx: Locked & Pick<Prisma.TransactionClient, "booking">, bookingId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
  return tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { observatory: { select: { mode: true } } },
  });
}

/**
 * A refusal changes no payment row, so its audit row is written on the base
 * client rather than the transaction that is about to be rolled back with
 * nothing in it. The row is the point: a provider misconfigured to report the
 * wrong amount, or replaying an old ref, is invisible without one.
 */
async function refuse(
  database: ReturnType<typeof getDatabase>,
  provider: PaymentProvider,
  outcome: PaymentOutcome,
  message: string,
  detail: Record<string, unknown>,
): Promise<SettlementFailure> {
  await recordAuditEvent(
    {
      category: "PAYMENT",
      action: "PAYMENT_WEBHOOK_REFUSED",
      entityType: "Payment",
      entityId: outcome.paymentId,
      detail: { provider, providerRef: outcome.providerRef, result: outcome.result, ...detail },
    },
    database,
  );

  return { ok: false, status: 400, code: "BAD_REQUEST", message };
}
