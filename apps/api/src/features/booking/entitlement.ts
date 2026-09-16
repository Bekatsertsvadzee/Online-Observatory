import "server-only";

import type { Booking, ErrorCode, RescheduleBookingRequest } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";
import { queueEmail } from "@darkview/db/notifications";
import { refundEntitledBooking } from "@darkview/db/refunds";

import { findBookableObservatory } from "@/features/booking/observatories";
import {
  BOOKING_ENTITLEMENT_SELECT,
  expireLapsedHolds,
  findGeneratedSlot,
  isSlotConflict,
  retryOnDeadlock,
  targetTooLongForSlot,
  toContractBooking,
} from "@/features/booking/reserve";
import { getDatabase } from "@/lib/db/client";

/**
 * A customer spends the entitlement a lost slot gave them (DV-111).
 *
 * The entitlement is created by the realtime service when a slot ends; this is the
 * customer's half. Both choices claim the entitlement with a conditional update on
 * OPEN, so a refund and a reschedule racing on one entitlement cannot both succeed.
 */

type Refusal = {
  ok: false;
  status: 404 | 409 | 422 | 503;
  code: ErrorCode;
  message: string;
};

const notFound: Refusal = { ok: false, status: 404, code: "NOT_FOUND", message: "No such booking." };
const noEntitlement: Refusal = {
  ok: false,
  status: 409,
  code: "CONFLICT",
  message: "This booking has no open refund or reschedule.",
};

async function readBooking(bookingId: string): Promise<Booking> {
  const row = await getDatabase().booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: { entitlement: BOOKING_ENTITLEMENT_SELECT },
  });
  return toContractBooking(row);
}

export async function refundMyBooking(input: {
  userId: string;
  bookingId: string;
  now: Date;
}): Promise<{ ok: true; booking: Booking } | Refusal> {
  const owned = await getDatabase().booking.findFirst({
    where: { id: input.bookingId, userId: input.userId },
    select: { id: true },
  });
  if (!owned) return notFound;

  const result = await getDatabase().$transaction((tx) =>
    refundEntitledBooking(tx, {
      bookingId: owned.id,
      actorUserId: input.userId,
      automatic: false,
      now: input.now,
    }),
  );

  if (!result.ok) {
    if (result.reason === "PROVIDER_REFUND_UNAVAILABLE") {
      return {
        ok: false,
        status: 503,
        code: "INTERNAL",
        message:
          "Refunds are not yet available for this payment method. Your refund or reschedule stays open.",
      };
    }
    return noEntitlement;
  }

  return { ok: true, booking: await readBooking(owned.id) };
}

/** Thrown inside the transaction when the entitlement was claimed first, so the new booking rolls back. */
class EntitlementGone extends Error {}

export async function rescheduleMyBooking(input: {
  userId: string;
  bookingId: string;
  request: RescheduleBookingRequest;
  now: Date;
}): Promise<{ ok: true; booking: Booking } | Refusal> {
  const { userId, request, now } = input;
  const database = getDatabase();

  const original = await database.booking.findFirst({
    where: { id: input.bookingId, userId },
    select: {
      id: true,
      observatoryId: true,
      targetId: true,
      durationMinutes: true,
      currency: true,
      isDemo: true,
      entitlement: { select: { id: true, outcome: true, expiresAt: true } },
    },
  });
  if (!original) return notFound;

  const entitlement = original.entitlement;
  if (!entitlement || entitlement.outcome !== "OPEN" || !entitlement.expiresAt || entitlement.expiresAt <= now) {
    return noEntitlement;
  }

  // The same telescope (ADR-015): the customer bought time on this instrument.
  const observatory = await findBookableObservatory(original.observatoryId);
  if (!observatory) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "This telescope cannot be booked right now. Your refund stays available.",
    };
  }

  const targetId = request.targetId ?? original.targetId;
  const target = await database.target.findUnique({ where: { id: targetId } });
  if (!target || !target.enabled) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such target." };
  }

  const slotStartAt = new Date(request.slotStartAt);
  const slot = Number.isNaN(slotStartAt.getTime())
    ? null
    : findGeneratedSlot(slotStartAt, observatory, now);
  if (!slot) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "That instant is not a slot this telescope offers. Slots come from GET /slots.",
    };
  }
  if (slot.durationMinutes !== original.durationMinutes) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: `A reschedule is for the same length: ${original.durationMinutes} minutes.`,
    };
  }
  const tooLong = targetTooLongForSlot(target, slot.durationMinutes);
  if (tooLong) return { ok: false, status: 422, code: "VALIDATION_FAILED", message: tooLong };
  switch (slot.unavailableReason) {
    case "IN_THE_PAST":
      return { ok: false, status: 409, code: "SLOT_UNAVAILABLE", message: "That slot has already started." };
    case "WEATHER_HOLD":
      return { ok: false, status: 409, code: "WEATHER_HOLD", message: "The telescope is on weather hold for that night." };
    case "OBSERVATORY_OFFLINE":
      return { ok: false, status: 409, code: "OBSERVATORY_OFFLINE", message: "The telescope is offline." };
    default:
      break;
  }

  try {
    const bookingId = await retryOnDeadlock(() =>
      database.$transaction(async (tx) => {
        await expireLapsedHolds(
          tx as unknown as Parameters<typeof expireLapsedHolds>[0],
          observatory.id,
          now,
        );

        const { mode } = await tx.observatory.findUniqueOrThrow({
          where: { id: observatory.id },
          select: { mode: true },
        });

        // Free, and confirmed at once: the customer already paid, for the slot they lost.
        const booking = await tx.booking.create({
          data: {
            userId,
            targetId,
            observatoryId: observatory.id,
            telescopeId: observatory.telescopeId,
            slotStartAt,
            durationMinutes: slot.durationMinutes,
            status: "CONFIRMED",
            priceMinor: 0,
            currency: original.currency,
            isDemo: original.isDemo,
          },
        });

        // Claimed after the booking exists, so it can name it, and conditionally, so a
        // refund that committed first rolls this whole reschedule back.
        const { count } = await tx.bookingEntitlement.updateMany({
          where: { id: entitlement.id, outcome: "OPEN", expiresAt: { gt: now } },
          data: { outcome: "RESCHEDULED", resolvedAt: now, rescheduledBookingId: booking.id },
        });
        if (count === 0) throw new EntitlementGone();

        // ADR-004, as settlement does it: a booked mission is born SCHEDULED.
        const mission = await tx.mission.create({
          data: {
            userId,
            targetId,
            observatoryId: observatory.id,
            telescopeId: observatory.telescopeId,
            state: "SCHEDULED",
            mode,
            isDemo: original.isDemo,
            requestedAt: now,
            scheduledFor: slotStartAt,
          },
        });
        await tx.missionEvent.create({
          data: {
            missionId: mission.id,
            state: "SCHEDULED",
            source: "CLOUD",
            message: "Rescheduled free of charge after a lost slot.",
            occurredAt: now,
            simulated: mode === "SIMULATED",
            isDemo: original.isDemo,
          },
        });
        await tx.booking.update({ where: { id: booking.id }, data: { missionId: mission.id } });

        await recordAuditEvent(
          {
            category: "BOOKING",
            action: "BOOKING_RESCHEDULED",
            actorUserId: userId,
            missionId: mission.id,
            entityType: "Booking",
            entityId: original.id,
            detail: {
              rescheduledBookingId: booking.id,
              slotStartAt: slotStartAt.toISOString(),
              durationMinutes: slot.durationMinutes,
              targetId,
            },
            isDemo: original.isDemo,
          },
          tx,
        );
        await queueEmail(tx, {
          userId,
          kind: "BOOKING_CONFIRMED",
          dedupeKey: `booking-confirmed:${booking.id}`,
          payload: { bookingId: booking.id },
        });

        return booking.id;
      }),
    );

    return { ok: true, booking: await readBooking(bookingId) };
  } catch (error) {
    if (error instanceof EntitlementGone) return noEntitlement;
    if (isSlotConflict(error)) {
      return { ok: false, status: 409, code: "SLOT_UNAVAILABLE", message: "That slot has just been taken." };
    }
    throw error;
  }
}
