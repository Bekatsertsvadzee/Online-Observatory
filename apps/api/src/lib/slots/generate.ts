import type { Slot, SlotUnavailableReason } from "@darkview/contracts";

import type { NightWindow } from "@/lib/slots/darkness";

/**
 * How long one customer has the telescope.
 *
 * DV-052 derived two session lengths from the observing method -- 15 minutes for
 * short-exposure targets, 30 for the ones the Build Plan says need live stacking.
 * Neither number comes from a controlling document: the Build Plan says session
 * lengths live on the /pricing page and never states them.
 *
 * Phase 1 sells one slot length, and it is the longer of the two, so that any
 * catalogue target fits in any slot. Selling a 15-minute slot and then letting a
 * customer choose M13 would be selling something we cannot deliver.
 *
 * CHANGE THIS ONE CONSTANT when pricing is settled. Nothing else encodes it.
 */
export const SLOT_DURATION_MINUTES = 30;

/**
 * Dead time between customers: park, slew to the next target, refocus, and
 * absorb an overrun without eating into the next booking. Build Plan section 01
 * calls for a refocus every 45-60 minutes or after a 2 degree temperature change,
 * so some of these gaps carry one.
 */
export const SLOT_TURNAROUND_MINUTES = 10;

/**
 * PROVISIONAL. In tetri, the minor unit of the Georgian lari: 4500 = 45.00 GEL.
 *
 * No controlling document sets a price. This exists so the contract's required
 * priceMinor has a value and so the type is exercised end to end; it is not a
 * commercial decision and must be replaced before anything is sold.
 *
 * Integer minor units, never a float. 0.1 + 0.2 is not 0.3 in binary floating
 * point, and money that does not add up is not a rounding curiosity, it is a
 * reconciliation failure against a payment provider.
 */
export const PROVISIONAL_SLOT_PRICE_MINOR = 4500;

/**
 * Slots start on a five-minute boundary.
 *
 * Darkness begins at whatever instant the Sun crosses -18 degrees -- 22:50:07.099
 * on one June evening -- and a booking page offering "22:50:07" looks broken. The
 * first slot is therefore pushed forward to the next five-minute mark.
 *
 * Forward, never back: rounding down would start the session while the sky is
 * still too bright, which is the one direction that costs an observation rather
 * than a few minutes of inventory. At this site the delay has never cost a slot,
 * because the stride is forty minutes and the rounding is at most five.
 */
export const SLOT_ALIGNMENT_MINUTES = 5;

function alignForward(at: Date, minutes: number): Date {
  const step = minutes * 60_000;
  return new Date(Math.ceil(at.getTime() / step) * step);
}

export type SlotAvailabilityInput = {
  window: NightWindow;
  now: Date;
  observatory: { online: boolean; weatherHold: boolean };
  /** Start instants already held by a confirmed booking. */
  bookedStartAt: ReadonlySet<number>;
};

/**
 * Which single reason to report, when more than one applies.
 *
 * The contract carries one reason, not a list, so the order is a decision rather
 * than an accident. It runs from the most specific and most actionable to the
 * least:
 *
 *   IN_THE_PAST         nothing the customer can do; the slot is simply gone
 *   ALREADY_BOOKED      specific to this slot -- another slot will work
 *   WEATHER_HOLD        the whole night is off, but tomorrow may not be
 *   OBSERVATORY_OFFLINE a fault, and the least useful thing to tell someone
 *
 * OUTSIDE_ASTRONOMICAL_DARKNESS never appears here, because slots are generated
 * from the dark window and so cannot fall outside it. It exists for DV-055,
 * where a booking request naming an arbitrary instant has to be refused.
 */
function unavailableReason(
  slotStartAt: Date,
  input: SlotAvailabilityInput,
): SlotUnavailableReason | null {
  if (slotStartAt.getTime() <= input.now.getTime()) return "IN_THE_PAST";
  if (input.bookedStartAt.has(slotStartAt.getTime())) return "ALREADY_BOOKED";
  if (input.observatory.weatherHold) return "WEATHER_HOLD";
  if (!input.observatory.online) return "OBSERVATORY_OFFLINE";
  return null;
}

/**
 * Tile the dark window with slots.
 *
 * A slot is only emitted if it fits entirely inside darkness. A session that
 * would run past dawn is not offered at all rather than offered short: the
 * customer booked thirty minutes on a telescope, and thirty minutes is what the
 * slot has to be able to deliver.
 */
export function generateSlots(input: SlotAvailabilityInput): Slot[] {
  const durationMs = SLOT_DURATION_MINUTES * 60_000;
  const strideMs = (SLOT_DURATION_MINUTES + SLOT_TURNAROUND_MINUTES) * 60_000;

  const slots: Slot[] = [];
  const firstStart = alignForward(input.window.duskAt, SLOT_ALIGNMENT_MINUTES);

  for (
    let startMs = firstStart.getTime();
    startMs + durationMs <= input.window.dawnAt.getTime();
    startMs += strideMs
  ) {
    const startAt = new Date(startMs);
    const reason = unavailableReason(startAt, input);

    slots.push({
      startAt: startAt.toISOString(),
      endAt: new Date(startMs + durationMs).toISOString(),
      durationMinutes: SLOT_DURATION_MINUTES,
      available: reason === null,
      priceMinor: PROVISIONAL_SLOT_PRICE_MINOR,
      currency: "GEL",
      unavailableReason: reason,
    });
  }

  return slots;
}
