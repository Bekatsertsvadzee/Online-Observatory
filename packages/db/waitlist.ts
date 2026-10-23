import { queueEmail } from "./notifications";
import type { Prisma, PrismaClient } from "./generated/prisma/client.ts";

/**
 * Clients ADR-068: the waitlist for a taken slot.
 *
 * Here because both services act on it: the API lets people join, leave and reserve
 * an offered slot; the realtime service, the only long-lived process, offers freed
 * slots and lapses unclaimed offers on a timer.
 */

/** How long a freed slot is held for the first person waiting for it. */
export const WAITLIST_OFFER_MINUTES = 15;

/** Active (WAITING or OFFERED) places one person may hold at once. */
export const MAX_ACTIVE_PLACES = 3;

/**
 * The turnaround the booking exclusion constraint adds after every session
 * (migration 20261022120000_slot_turnaround_exclusion). The API's
 * SLOT_TURNAROUND_MINUTES is the same number; a unit test there holds them together.
 */
export const TURNAROUND_MINUTES = 10;

export const ACTIVE_PLACE = ["WAITING", "OFFERED"] as const;

type Reader = Pick<Prisma.TransactionClient, "booking" | "waitlistEntry">;

/** [start, start + duration + turnaround), as the exclusion constraint holds a booking. */
function span(startAt: Date, durationMinutes: number) {
  const start = startAt.getTime();
  return { start, end: start + (durationMinutes + TURNAROUND_MINUTES) * 60_000 };
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }) {
  return a.start < b.end && b.start < a.end;
}

/** A day either side is longer than any session plus its turnaround. */
const LOOK_MS = 24 * 60 * 60_000;

/**
 * The bookings that hold the telescope across a slot: confirmed, or reserved and not
 * yet lapsed -- the same rule `GET /slots` uses.
 */
export async function bookingsHolding(
  reader: Reader,
  slot: { observatoryId: string; slotStartAt: Date; durationMinutes: number },
  now: Date,
): Promise<{ id: string; userId: string }[]> {
  const wanted = span(slot.slotStartAt, slot.durationMinutes);
  const rows = await reader.booking.findMany({
    where: {
      observatoryId: slot.observatoryId,
      slotStartAt: {
        gt: new Date(wanted.start - LOOK_MS),
        lt: new Date(wanted.end + LOOK_MS),
      },
      OR: [{ status: "CONFIRMED" }, { status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } }],
    },
    select: { id: true, userId: true, slotStartAt: true, durationMinutes: true },
  });
  return rows
    .filter((row) => overlaps(wanted, span(row.slotStartAt, row.durationMinutes)))
    .map(({ id, userId }) => ({ id, userId }));
}

/**
 * Open offers that overlap a slot, for anybody but `exceptUserId`. A slot overlapping one
 * is HELD_FOR_WAITLIST to everyone else until the offer is claimed or lapses.
 */
export async function offersAround(
  reader: Reader,
  slot: { observatoryId: string; slotStartAt: Date; durationMinutes: number },
  now: Date,
  exceptUserId: string | null,
): Promise<{ slotStartAt: Date; durationMinutes: number }[]> {
  const wanted = span(slot.slotStartAt, slot.durationMinutes);
  const rows = await reader.waitlistEntry.findMany({
    where: {
      observatoryId: slot.observatoryId,
      status: "OFFERED",
      offerExpiresAt: { gt: now },
      slotStartAt: {
        gt: new Date(wanted.start - LOOK_MS),
        lt: new Date(wanted.end + LOOK_MS),
      },
      ...(exceptUserId ? { userId: { not: exceptUserId } } : {}),
    },
    select: { slotStartAt: true, durationMinutes: true },
  });
  return rows.filter((row) => overlaps(wanted, span(row.slotStartAt, row.durationMinutes)));
}

export type WaitlistSweep = {
  ended: number;
  claimed: number;
  lapsed: number;
  offered: number;
};

/**
 * One pass over the waitlist. Safe to run twice at once: every change is a conditional
 * update, and `WaitlistEntry_one_offer_per_slot_key` refuses a second offer on a slot.
 *
 * 1. A place whose slot has started is ENDED.
 * 2. A place whose holder now holds the slot themselves -- they reserved the offer, or
 *    booked it when it freed -- is CLAIMED.
 * 3. An offer whose fifteen minutes ran out is LAPSED.
 * 4. A slot with people waiting, no open offer and nobody holding it is offered to the
 *    first in line, who is emailed.
 */
export async function sweepWaitlist(database: PrismaClient, now: Date): Promise<WaitlistSweep> {
  const result: WaitlistSweep = { ended: 0, claimed: 0, lapsed: 0, offered: 0 };

  result.ended = (
    await database.waitlistEntry.updateMany({
      where: { status: { in: [...ACTIVE_PLACE] }, slotStartAt: { lte: now } },
      data: { status: "ENDED", endedAt: now },
    })
  ).count;

  const active = await database.waitlistEntry.findMany({
    where: { status: { in: [...ACTIVE_PLACE] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  for (const entry of active) {
    const holders = await bookingsHolding(database, entry, now);
    const mine = holders.find((holder) => holder.userId === entry.userId);
    if (mine) {
      const { count } = await database.waitlistEntry.updateMany({
        where: { id: entry.id, status: entry.status },
        data: { status: "CLAIMED", claimedBookingId: mine.id, endedAt: now },
      });
      result.claimed += count;
      continue;
    }
    if (entry.status === "OFFERED" && entry.offerExpiresAt && entry.offerExpiresAt <= now) {
      const { count } = await database.waitlistEntry.updateMany({
        where: { id: entry.id, status: "OFFERED" },
        data: { status: "LAPSED", endedAt: now },
      });
      result.lapsed += count;
    }
  }

  // The first WAITING place per slot, in the order people joined.
  const waiting = await database.waitlistEntry.findMany({
    where: { status: "WAITING", slotStartAt: { gt: now } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const seen = new Set<string>();
  for (const entry of waiting) {
    const key = `${entry.observatoryId}:${entry.slotStartAt.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const offered = await database.waitlistEntry.count({
      where: {
        observatoryId: entry.observatoryId,
        slotStartAt: entry.slotStartAt,
        status: "OFFERED",
      },
    });
    if (offered > 0) continue;
    if ((await bookingsHolding(database, entry, now)).length > 0) continue;
    if ((await offersAround(database, entry, now, entry.userId)).length > 0) continue;

    const offerExpiresAt = new Date(now.getTime() + WAITLIST_OFFER_MINUTES * 60_000);
    try {
      await database.$transaction(async (tx) => {
        const { count } = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, status: "WAITING" },
          data: { status: "OFFERED", offeredAt: now, offerExpiresAt },
        });
        if (count === 0) return;
        await queueEmail(tx, {
          userId: entry.userId,
          kind: "WAITLIST_OFFER",
          dedupeKey: `waitlist-offer:${entry.id}`,
          payload: { waitlistEntryId: entry.id },
        });
        result.offered += 1;
      });
    } catch (error) {
      // Another pass offered this slot first: the partial unique index said so.
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
  }

  return result;
}
