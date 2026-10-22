import "server-only";

import type { SlotList } from "@darkview/contracts";

import { findBookableObservatory } from "@/features/booking/observatories";
import { getDatabase } from "@/lib/db/client";
import { openIntervals } from "@/lib/slots/availability";
import { nightWindow } from "@/lib/slots/darkness";
import {
  generateSlots,
  SLOT_DURATION_MINUTES,
  SLOT_TURNAROUND_MINUTES,
} from "@/lib/slots/generate";

/**
 * How far before dusk a held booking's start is still read. A booking that began
 * before the window can still reach into it with its duration and turnaround; a
 * day is longer than any session, and the rows are one observatory's few bookings.
 */
const HELD_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Bookable slots on one observatory, for one of its local dates.
 *
 * The date names the night that *begins* that evening: asking for 3 September
 * returns the window from dusk on the 3rd to dawn on the 4th, which is what
 * someone means when they say they want to observe on Thursday.
 *
 * Null when the observatory is not bookable -- unknown, or its node is not
 * APPROVED -- and the route answers that with 404. An empty night and a telescope
 * nobody may book are different facts: the first is an honest list with nothing on
 * it, the second is not a list at all.
 */
export async function listSlotsForDate(
  observatoryId: string,
  isoDate: string,
  now: Date,
): Promise<SlotList | null> {
  const observatory = await findBookableObservatory(observatoryId);
  if (!observatory) return null;

  const empty = { observatoryId: observatory.id, date: isoDate, items: [] };

  const window = nightWindow(isoDate, observatory.timezone, {
    latitudeDegrees: observatory.latitude,
    longitudeDegrees: observatory.longitude,
  });

  // No astronomical darkness at all: an honest empty night, not an error.
  if (!window) return empty;

  // The hours the owner offered, narrowed to the hours the sky allows (DV-121).
  const open = openIntervals(window, observatory.windows, observatory.timezone);
  if (open.length === 0) return empty;

  // A booking holds its slot from the moment it is reserved, not from the moment
  // it is paid for -- the same rule the exclusion constraint enforces in the
  // database (DV-055, DV-066). An unpaid hold stops holding once it lapses, so the slot
  // reappears here without anything having to sweep the table first. Cancelled,
  // expired and refunded bookings never held it.
  const held = await getDatabase().booking.findMany({
    where: {
      observatoryId: observatory.id,
      slotStartAt: {
        gt: new Date(window.duskAt.getTime() - HELD_LOOKBACK_MS),
        lt: new Date(window.dawnAt.getTime() + SLOT_TURNAROUND_MINUTES * 60_000),
      },
      OR: [
        { status: "CONFIRMED" },
        { status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
      ],
    },
    select: { slotStartAt: true, durationMinutes: true },
  });

  // Generated per open interval, not once across the night. Each contiguous opening
  // starts its own run of quarter-hour starts: a gap in the middle of the evening is
  // a gap the owner asked for, and carrying the grid across it would place a slot
  // inside hours they did not offer.
  const state = {
    online: observatory.status === "ONLINE",
    weatherHold: observatory.weatherHold,
  };

  return {
    ...empty,
    items: open.flatMap((interval) =>
      generateSlots({
        observatoryId: observatory.id,
        window: interval,
        now,
        observatory: state,
        held,
      }),
    ),
  };
}

export { SLOT_DURATION_MINUTES };
