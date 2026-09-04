import "server-only";

import type { SlotList } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
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

  return {
    date: isoDate,
    items: generateSlots({
      window,
      now,
      observatory: {
        online: observatory.status === "ONLINE",
        weatherHold: observatory.weatherState?.holdActive ?? false,
      },
      bookedStartAt: new Set(held.map((row) => row.slotStartAt.getTime())),
    }),
  };
}

export { SLOT_DURATION_MINUTES };
