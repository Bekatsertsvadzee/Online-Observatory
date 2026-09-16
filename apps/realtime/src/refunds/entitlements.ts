import type { PrismaClient } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";
import { queueEmail } from "@darkview/db/notifications";
import { refundEntitledBooking } from "@darkview/db/refunds";

/**
 * DV-111: what an ended slot entitles its customer to, and the thirty-day refund.
 *
 * Here because this is the only long-lived process; like the no-show sweep, an
 * API that evaluated on request would leave a lost slot unevaluated for as long as
 * nobody asked.
 *
 * Maintainer rules, 2026-09-15 (issue #93):
 *
 * - A slot lost to **weather** or to **our fault** -- internet or power (the agent
 *   link down), a telescope or hardware fault, an operator stopping it -- where the
 *   customer lost **half the slot or more**, entitles them to choose a full refund
 *   or a free reschedule.
 * - A reschedule must be used within **thirty days**; an entitlement still open then
 *   is refunded automatically.
 * - A customer who did not show up, or who ended the session themselves, gets
 *   nothing.
 *
 * **Minutes lost are reconstructed from records, never asserted.** Two sources, and
 * their union is what counts:
 *
 * 1. The observatory being unavailable: a weather hold in force, or the agent link
 *    down, read from the audit rows the hold and the link already write.
 * 2. The mission ending on our side: from the moment of its final event to the end
 *    of the slot.
 *
 * A slot nobody started because the observatory was offline is therefore not a
 * no-show -- the no-show sweep closes the mission either way, and the unavailable
 * time is what separates the two.
 */

export const RESCHEDULE_WINDOW_DAYS = 30;

/**
 * How long after a slot ends before it is judged. Long enough for the no-show
 * sweep and a late agent event to land first.
 */
export const EVALUATION_GRACE_MINUTES = 5;

/** Endings that are the customer's, not ours. Nothing is owed for these. */
const CUSTOMER_ENDINGS = new Set(["CUSTOMER_CANCELLED", "PAYMENT_FAILED"]);

/**
 * ADR-018's no-show sweep. It says nobody started the slot, not why: the observatory
 * being unavailable is what separates a no-show from a slot we could not offer, so
 * this ending is judged on unavailability alone and never counts as ended on our side.
 */
const NOT_STARTED = "SESSION_EXPIRED";

const HOLD_ACTIONS = ["WEATHER_HOLD_SET", "WEATHER_HOLD_CLEARED"];
const LINK_ACTIONS = ["AGENT_LINK_LOST", "AGENT_LINK_UP"];

/** States a mission that did not finish normally ends in. */
const ENDED_EARLY = new Set(["FAILED", "CANCELLED", "WEATHER_HOLD", "HARDWARE_ERROR", "NOT_VISIBLE"]);

type Cause = "WEATHER" | "OBSERVATORY_FAULT";
type Interval = { from: number; to: number; cause: Cause };

export type SlotLoss = { minutesLost: number; cause: Cause | null };

/**
 * The union of the intervals, clipped to the slot, in milliseconds by cause.
 *
 * Where weather and a fault overlap the minute is counted once, and credited to
 * weather: an observatory under a hold was not going to observe whether or not
 * the link was up.
 */
export function lostWithin(intervals: Interval[], start: number, end: number): SlotLoss {
  const clipped = intervals
    .map((interval) => ({ ...interval, from: Math.max(interval.from, start), to: Math.min(interval.to, end) }))
    .filter((interval) => interval.to > interval.from);

  const edges = [...new Set(clipped.flatMap((interval) => [interval.from, interval.to]))].sort(
    (a, b) => a - b,
  );

  let weather = 0;
  let fault = 0;
  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index];
    const to = edges[index + 1];
    const covering = clipped.filter((interval) => interval.from <= from && interval.to >= to);
    if (covering.length === 0) continue;
    if (covering.some((interval) => interval.cause === "WEATHER")) weather += to - from;
    else fault += to - from;
  }

  const total = weather + fault;
  if (total === 0) return { minutesLost: 0, cause: null };
  return {
    minutesLost: Math.round(total / 60_000),
    cause: weather >= fault ? "WEATHER" : "OBSERVATORY_FAULT",
  };
}

/** Weather holds and link outages at an observatory, as intervals, from its audit rows. */
async function unavailability(
  database: PrismaClient,
  observatoryId: string,
  start: number,
  end: number,
): Promise<Interval[]> {
  const observatory = { entityType: "Observatory", entityId: observatoryId };
  const select = { action: true, createdAt: true } as const;

  // The state each of the two was in when the slot began, however long ago it was
  // set: a link lost ten days before a slot and never restored is still down.
  const lastBefore = (actions: string[]) =>
    database.auditLog.findFirst({
      where: { ...observatory, action: { in: actions }, createdAt: { lt: new Date(start) } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select,
    });

  const [hold, link, during] = await Promise.all([
    lastBefore(HOLD_ACTIONS),
    lastBefore(LINK_ACTIONS),
    database.auditLog.findMany({
      where: {
        ...observatory,
        action: { in: [...HOLD_ACTIONS, ...LINK_ACTIONS] },
        createdAt: { gte: new Date(start), lt: new Date(end) },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select,
    }),
  ]);

  const rows = [
    ...[hold, link]
      .filter((row) => row !== null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    ...during,
  ];

  const intervals: Interval[] = [];
  let holdSince: number | null = null;
  let downSince: number | null = null;

  for (const row of rows) {
    const at = row.createdAt.getTime();
    switch (row.action) {
      case "WEATHER_HOLD_SET":
        holdSince ??= at;
        break;
      case "WEATHER_HOLD_CLEARED":
        if (holdSince !== null) intervals.push({ from: holdSince, to: at, cause: "WEATHER" });
        holdSince = null;
        break;
      case "AGENT_LINK_LOST":
        downSince ??= at;
        break;
      case "AGENT_LINK_UP":
        if (downSince !== null) intervals.push({ from: downSince, to: at, cause: "OBSERVATORY_FAULT" });
        downSince = null;
        break;
    }
  }
  // Still in force when the slot ended.
  if (holdSince !== null) intervals.push({ from: holdSince, to: end, cause: "WEATHER" });
  if (downSince !== null) intervals.push({ from: downSince, to: end, cause: "OBSERVATORY_FAULT" });

  return intervals;
}

/** Evaluate every confirmed booking whose slot has ended and has not been judged. */
export async function evaluateEndedSlots(database: PrismaClient, now: Date): Promise<number> {
  const judgeableBefore = new Date(now.getTime() - EVALUATION_GRACE_MINUTES * 60_000);

  const candidates = await database.booking.findMany({
    where: {
      status: "CONFIRMED",
      entitlement: { is: null },
      slotStartAt: { lte: judgeableBefore },
    },
    select: {
      id: true,
      userId: true,
      observatoryId: true,
      slotStartAt: true,
      durationMinutes: true,
      mission: {
        select: {
          state: true,
          failureReason: true,
          events: {
            orderBy: { occurredAt: "desc" },
            take: 1,
            select: { occurredAt: true },
          },
        },
      },
    },
  });

  let granted = 0;
  for (const booking of candidates) {
    const start = booking.slotStartAt.getTime();
    const end = start + booking.durationMinutes * 60_000;
    if (end > judgeableBefore.getTime()) continue;

    const mission = booking.mission;
    const customerEnded = CUSTOMER_ENDINGS.has(mission?.failureReason ?? "");

    let loss: SlotLoss = { minutesLost: 0, cause: null };
    if (!customerEnded) {
      const intervals = await unavailability(database, booking.observatoryId, start, end);

      // The mission ending on our side: from its last event to the end of the slot.
      if (
        mission &&
        ENDED_EARLY.has(mission.state) &&
        mission.failureReason !== NOT_STARTED &&
        mission.events[0]
      ) {
        intervals.push({
          from: mission.events[0].occurredAt.getTime(),
          to: end,
          cause:
            mission.state === "WEATHER_HOLD" || mission.failureReason === "WEATHER_UNSAFE"
              ? "WEATHER"
              : "OBSERVATORY_FAULT",
        });
      }

      loss = lostWithin(intervals, start, end);
    }

    const entitled = loss.cause !== null && loss.minutesLost * 2 >= booking.durationMinutes;

    const written = await database.$transaction(async (tx) => {
      const { count } = await tx.bookingEntitlement.createMany({
        data: [
          {
            bookingId: booking.id,
            userId: booking.userId,
            outcome: entitled ? "OPEN" : "NONE",
            cause: entitled ? loss.cause : null,
            minutesLost: loss.minutesLost,
            evaluatedAt: now,
            expiresAt: entitled
              ? new Date(now.getTime() + RESCHEDULE_WINDOW_DAYS * 86_400_000)
              : null,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0 || !entitled) return false;

      await recordAuditEvent(
        {
          category: "BOOKING",
          action: "BOOKING_ENTITLEMENT_GRANTED",
          actorUserId: null,
          entityType: "Booking",
          entityId: booking.id,
          detail: {
            cause: loss.cause,
            minutesLost: loss.minutesLost,
            durationMinutes: booking.durationMinutes,
          },
        },
        tx,
      );
      await queueEmail(tx, {
        userId: booking.userId,
        kind: "ENTITLEMENT_AVAILABLE",
        dedupeKey: `entitlement-available:${booking.id}`,
        payload: { bookingId: booking.id },
      });
      return true;
    });

    if (written) granted += 1;
  }
  return granted;
}

/**
 * Refund every entitlement still open past its thirty days.
 *
 * One that cannot be refunded -- a live provider with no refund integration yet --
 * stays open and is counted, so the process can say so rather than retry silently
 * forever.
 */
export async function refundExpiredEntitlements(
  database: PrismaClient,
  now: Date,
): Promise<{ refunded: number; unrefundable: number }> {
  const expired = await database.bookingEntitlement.findMany({
    where: { outcome: "OPEN", expiresAt: { lte: now } },
    select: { bookingId: true },
  });

  let refunded = 0;
  let unrefundable = 0;
  for (const { bookingId } of expired) {
    const result = await database.$transaction((tx) =>
      refundEntitledBooking(tx, { bookingId, actorUserId: null, automatic: true, now }),
    );
    if (result.ok) refunded += 1;
    else if (result.reason === "PROVIDER_REFUND_UNAVAILABLE") unrefundable += 1;
  }
  return { refunded, unrefundable };
}
