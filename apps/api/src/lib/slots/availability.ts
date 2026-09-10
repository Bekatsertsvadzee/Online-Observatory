import type { NightWindow } from "@/lib/slots/darkness";
import { localWallClockToUtc } from "@/lib/slots/darkness";

/**
 * The hours an observatory's owner has offered, narrowing the hours physics allows.
 *
 * ADR-013 lets somebody else's telescope join the network and be available "during
 * hours the owner chooses". This is where that choice meets the sky.
 *
 * **Windows intersect darkness; they never replace it.** An owner who offers two
 * in the afternoon has not created an observation slot -- the agent's Sun
 * avoidance would refuse the slew, so selling it would be selling something the
 * observatory is built to refuse. Availability can only ever take hours away from
 * the dark window, never add them.
 *
 * **No windows means no restriction.** A node with nothing recorded is offered
 * across the whole night, which is exactly what every deployment does today.
 * The alternative -- treating silence as "not offered" -- would empty the slot
 * list of any existing installation the moment this shipped, and an owner who
 * has not thought about hours has not thereby withdrawn their telescope.
 *
 * **A night spanning midnight is two windows, not one that wraps.** The table is
 * keyed by weekday, so Friday night's late hours are Saturday's early window.
 * A row whose end is not after its start is discarded rather than guessed at:
 * 22:00-02:00 is ambiguous about which day it lands on, and inventing an answer
 * would silently offer a telescope on a night nobody chose.
 */

/** One row of `NetworkAvailabilityWindow`, reduced to what the maths needs. */
export type LocalWindow = {
  /** 0 = Sunday, matching `Date.getUTCDay()` and the seeded rows. */
  weekday: number;
  /** Minutes after local midnight, inclusive. */
  startMinute: number;
  /** Minutes after local midnight, exclusive. 1439 is 23:59, not midnight. */
  endMinute: number;
};

const MINUTES_PER_DAY = 1440;

/** The observatory-local calendar date at an instant, as YYYY-MM-DD. */
function localDate(at: Date, timeZone: string): string {
  // en-CA renders ISO order (YYYY-MM-DD) without any manual assembly.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** The weekday of a local calendar date. 0 = Sunday. */
function weekdayOf(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The local date one day after `isoDate`. */
function nextDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Turn one weekday window into the instants it covers on a given local date.
 *
 * Built from `localWallClockToUtc` rather than by adding milliseconds to local
 * midnight, so a zone with a DST transition inside the night gets the offset that
 * actually applied at each end. Asia/Tbilisi has none; the site is configuration
 * and the next one might.
 */
function instantsFor(window: LocalWindow, isoDate: string, timeZone: string): NightWindow {
  const midnight = localWallClockToUtc(isoDate, 0, timeZone).getTime();
  return {
    duskAt: new Date(midnight + window.startMinute * 60_000),
    dawnAt: new Date(midnight + window.endMinute * 60_000),
  };
}

function overlap(a: NightWindow, b: NightWindow): NightWindow | null {
  const start = Math.max(a.duskAt.getTime(), b.duskAt.getTime());
  const end = Math.min(a.dawnAt.getTime(), b.dawnAt.getTime());
  if (end <= start) return null;
  return { duskAt: new Date(start), dawnAt: new Date(end) };
}

/**
 * Merge intervals that touch or overlap, so a contiguous run is tiled once.
 *
 * Two adjacent windows -- 18:00-21:00 and 21:00-23:00 -- describe one unbroken
 * three-hour opening. Left separate they would each be tiled from their own
 * start, and the slot that straddles 21:00 would never be offered even though the
 * telescope is free for it.
 */
function merge(intervals: NightWindow[]): NightWindow[] {
  const sorted = [...intervals].sort(
    (left, right) => left.duskAt.getTime() - right.duskAt.getTime(),
  );

  const merged: NightWindow[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.duskAt.getTime() <= last.dawnAt.getTime()) {
      if (interval.dawnAt.getTime() > last.dawnAt.getTime()) {
        merged[merged.length - 1] = { duskAt: last.duskAt, dawnAt: interval.dawnAt };
      }
      continue;
    }
    merged.push(interval);
  }
  return merged;
}

/**
 * The parts of one night the observatory is actually offered for.
 *
 * Returns the whole night unchanged when there are no usable windows -- see the
 * module note. Returns an empty array when windows exist but none of them reach
 * the dark hours, which is an owner who has offered only daylight: an honest
 * empty night rather than a silent fallback to selling the whole of it.
 */
export function openIntervals(
  night: NightWindow,
  windows: readonly LocalWindow[],
  timeZone: string,
): NightWindow[] {
  const usable = windows.filter(
    (window) =>
      window.endMinute > window.startMinute &&
      window.startMinute >= 0 &&
      window.endMinute <= MINUTES_PER_DAY,
  );

  if (usable.length === 0) return [night];

  // A night runs from dusk on one local date into dawn on the next, so both
  // dates' weekdays contribute. Reading only the evening's weekday would drop
  // every hour after local midnight.
  const evening = localDate(night.duskAt, timeZone);
  const dates = [evening, nextDate(evening)];

  const intersections: NightWindow[] = [];
  for (const date of dates) {
    const weekday = weekdayOf(date);
    for (const window of usable) {
      if (window.weekday !== weekday) continue;
      const clipped = overlap(night, instantsFor(window, date, timeZone));
      if (clipped) intersections.push(clipped);
    }
  }

  return merge(intersections);
}
