import "server-only";

import type { SlotList } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { openIntervals } from "@/lib/slots/availability";
import { nightWindow } from "@/lib/slots/darkness";
import { generateSlots, SLOT_DURATION_MINUTES } from "@/lib/slots/generate";

/**
 * Bookable slots for one local observatory date.
 *
 * The date names the night that *begins* that evening: asking for 3 September
 * returns the window from dusk on the 3rd to dawn on the 4th, which is what
 * someone means when they say they want to observe on Thursday.
 */
export async function listSlotsForDate(isoDate: string, now: Date): Promise<SlotList> {
  const database = getDatabase();

  const observatory = await database.observatory.findFirst({
    include: { weatherState: true },
    orderBy: { createdAt: "asc" },
  });

  if (!observatory) return { date: isoDate, items: [] };

  const window = nightWindow(isoDate, observatory.timezone, {
    latitudeDegrees: observatory.latitude,
    longitudeDegrees: observatory.longitude,
  });

  // No astronomical darkness at all: an honest empty night, not an error.
  if (!window) return { date: isoDate, items: [] };

  // The hours the owner offered, narrowed to the hours the sky allows (DV-121).
  //
  // Read from the APPROVED node only. A node in DRAFT, UNDER_REVIEW or SUSPENDED
  // is not offered to anybody, so its windows are not an opinion about
  // availability -- and treating them as one would let a suspended telescope
  // keep appearing on the booking page.
  //
  // Disabled rows are excluded here rather than filtered later: `enabled` is how
  // an owner switches a window off without deleting it, and a disabled window
  // must not be distinguishable from one that was never recorded.
  const node = await database.observatoryNetworkNode.findFirst({
    where: { observatoryId: observatory.id, approvalStatus: "APPROVED" },
    select: {
      availabilityWindows: {
        where: { enabled: true },
        select: { weekday: true, startMinute: true, endMinute: true },
      },
    },
  });

  const open = openIntervals(window, node?.availabilityWindows ?? [], observatory.timezone);
  if (open.length === 0) return { date: isoDate, items: [] };

  // A booking holds its slot from the moment it is reserved, not from the moment
  // it is paid for -- the same rule the partial unique index enforces in the
  // database (DV-055). An unpaid hold stops holding once it lapses, so the slot
  // reappears here without anything having to sweep the table first. Cancelled,
  // expired and refunded bookings never held it.
  const held = await database.booking.findMany({
    where: {
      observatoryId: observatory.id,
      slotStartAt: { gte: window.duskAt, lte: window.dawnAt },
      OR: [
        { status: "CONFIRMED" },
        { status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } },
      ],
    },
    select: { slotStartAt: true },
  });

  // Tiled per open interval, not once across the night. Each contiguous opening
  // starts its own run of slots: a gap in the middle of the evening is a gap the
  // owner asked for, and carrying the stride across it would place a slot inside
  // hours they did not offer.
  const bookedStartAt = new Set(held.map((row) => row.slotStartAt.getTime()));
  const state = {
    online: observatory.status === "ONLINE",
    weatherHold: observatory.weatherState?.holdActive ?? false,
  };

  return {
    date: isoDate,
    items: open.flatMap((interval) =>
      generateSlots({ window: interval, now, observatory: state, bookedStartAt }),
    ),
  };
}

export { SLOT_DURATION_MINUTES };
