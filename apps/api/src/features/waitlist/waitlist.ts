import "server-only";

import type {
  ErrorCode,
  JoinWaitlistRequest,
  WaitlistEntry,
  WaitlistEntryList,
} from "@darkview/contracts";
import {
  ACTIVE_PLACE,
  bookingsHolding,
  MAX_ACTIVE_PLACES,
} from "@darkview/db/waitlist";

import { findBookableObservatory } from "@/features/booking/observatories";
import { findGeneratedSlot } from "@/features/booking/reserve";
import { isSessionLength } from "@/lib/slots/generate";
import { getDatabase } from "@/lib/db/client";

/**
 * Clients ADR-068: a place in line for a slot somebody else holds. Offering a freed
 * slot is the realtime sweep's (`@darkview/db/waitlist`); this is joining, leaving and
 * reading.
 */

type Refusal = { ok: false; status: 404 | 409 | 422; code: ErrorCode; message: string };

/** Ended places stay readable this long, so a customer can see what became of them. */
const KEEP_ENDED_DAYS = 30;

type EntryRow = {
  id: string;
  observatoryId: string;
  slotStartAt: Date;
  durationMinutes: number;
  status: string;
  offerExpiresAt: Date | null;
  createdAt: Date;
};

function toContract(row: EntryRow, position: number | null): WaitlistEntry {
  return {
    id: row.id,
    observatoryId: row.observatoryId,
    slotStartAt: row.slotStartAt.toISOString(),
    durationMinutes: row.durationMinutes,
    status: row.status as WaitlistEntry["status"],
    position: row.status === "WAITING" ? position : null,
    offerExpiresAt: row.status === "OFFERED" ? (row.offerExpiresAt?.toISOString() ?? null) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A WAITING place's position: one more than the WAITING places that joined first. */
async function positionOf(row: EntryRow & { id: string }): Promise<number> {
  const ahead = await getDatabase().waitlistEntry.count({
    where: {
      observatoryId: row.observatoryId,
      slotStartAt: row.slotStartAt,
      status: "WAITING",
      OR: [
        { createdAt: { lt: row.createdAt } },
        { createdAt: row.createdAt, id: { lt: row.id } },
      ],
    },
  });
  return ahead + 1;
}

export async function listMyWaitlistEntries(userId: string, now: Date): Promise<WaitlistEntryList> {
  const rows = await getDatabase().waitlistEntry.findMany({
    where: {
      userId,
      OR: [
        { status: { in: [...ACTIVE_PLACE] } },
        { createdAt: { gt: new Date(now.getTime() - KEEP_ENDED_DAYS * 24 * 60 * 60_000) } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return {
    items: await Promise.all(
      rows.map(async (row) =>
        toContract(row, row.status === "WAITING" ? await positionOf(row) : null),
      ),
    ),
  };
}

export async function joinWaitlist(input: {
  userId: string;
  request: JoinWaitlistRequest;
  now: Date;
}): Promise<{ ok: true; body: WaitlistEntry } | Refusal> {
  const { userId, request, now } = input;
  const observatory = await findBookableObservatory(request.observatoryId);
  if (!observatory) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such observatory." };
  }

  const slotStartAt = new Date(request.slotStartAt);
  const slot =
    Number.isNaN(slotStartAt.getTime()) || !isSessionLength(request.durationMinutes)
      ? null
      : findGeneratedSlot(slotStartAt, observatory, now, request.durationMinutes);
  if (!slot) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "That is not a slot this observatory offers.",
    };
  }
  if (slot.unavailableReason === "IN_THE_PAST") {
    return { ok: false, status: 409, code: "CONFLICT", message: "That slot has started." };
  }

  const place = { observatoryId: observatory.id, slotStartAt, durationMinutes: slot.durationMinutes };
  const holders = await bookingsHolding(getDatabase(), place, now);
  if (holders.some((holder) => holder.userId === userId)) {
    return { ok: false, status: 409, code: "CONFLICT", message: "You already hold that slot." };
  }
  if (holders.length === 0) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Nobody holds that slot: book it instead.",
    };
  }

  const active = await getDatabase().waitlistEntry.count({
    where: { userId, status: { in: [...ACTIVE_PLACE] } },
  });
  if (active >= MAX_ACTIVE_PLACES) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: `You can wait for at most ${MAX_ACTIVE_PLACES} slots at once.`,
    };
  }

  try {
    const row = await getDatabase().waitlistEntry.create({
      data: { userId, ...place },
    });
    return { ok: true, body: toContract(row, await positionOf(row)) };
  } catch (error) {
    // WaitlistEntry_active_place_key: this person already waits for this slot.
    if ((error as { code?: string }).code === "P2002") {
      return { ok: false, status: 409, code: "CONFLICT", message: "You already wait for that slot." };
    }
    throw error;
  }
}

/** Leave the line, or turn an offer down. Another person's place and none are one 404. */
export async function leaveWaitlist(input: {
  userId: string;
  entryId: string;
  now: Date;
}): Promise<{ ok: true } | Refusal> {
  const row = await getDatabase().waitlistEntry.findFirst({
    where: { id: input.entryId, userId: input.userId },
    select: { id: true },
  });
  if (!row) return { ok: false, status: 404, code: "NOT_FOUND", message: "No such place." };

  await getDatabase().waitlistEntry.updateMany({
    where: { id: row.id, status: { in: [...ACTIVE_PLACE] } },
    data: { status: "LEFT", endedAt: input.now },
  });
  return { ok: true };
}
