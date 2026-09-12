import "server-only";

import type { ErrorCode, PaymentProvider } from "@darkview/contracts";
import type { Prisma } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";

import { releaseHeldSlot } from "@/features/booking/reserve";
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
 * Apply a verified provider outcome to Darkview's own Payment record, and to the
 * booking that payment holds.
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
      include: { booking: { select: { id: true, missionId: true } } },
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
        return { ok: true, applied: false, missionId: payment.booking?.missionId ?? null };
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
