import { Body, MakeTime, Observer, SearchAltitude } from "astronomy-engine";

import { SUN_ALTITUDE_DEEP_SKY } from "@/lib/ephemeris/visibility";
import type { Site } from "@/lib/ephemeris/engine";

/**
 * When it is actually dark at the installation site.
 *
 * Slots come from this, not from office hours. In Tbilisi the usable window runs
 * from about five hours in midsummer to more than eleven in midwinter, and a
 * fixed evening schedule would either sell darkness that does not exist in June
 * or throw away half the night in December.
 *
 * Astronomical darkness is the Sun at or below -18 degrees. That is the stricter
 * of the two thresholds in Build Plan section 01 -- solar-system targets are
 * permitted from -12 -- and it is used here on purpose: one slot has to serve
 * whatever target the customer picks, so the window must be dark enough for the
 * most demanding of them. Per-target gating still happens at request time in
 * DV-053.
 */
export const ASTRONOMICAL_DARKNESS_DEGREES = SUN_ALTITUDE_DEEP_SKY;

export type NightWindow = {
  /** Sun descends through -18. */
  duskAt: Date;
  /** Sun ascends through -18. */
  dawnAt: Date;
};

/**
 * The UTC instant of a given wall-clock hour on a local calendar date.
 *
 * A booking date is the observatory's local date, so "3 September" is the night
 * that begins on the evening of the 3rd. Converting that to an instant needs the
 * zone's offset, which is not constant everywhere and is not knowable without
 * asking. Two passes: guess at UTC, read the offset the zone actually had at
 * that guess, then correct. The second pass matters only near a DST boundary,
 * which Asia/Tbilisi does not have -- but the site is configuration, not a
 * constant, and this must not quietly break for the next one.
 */
export function localWallClockToUtc(
  isoDate: string,
  hour: number,
  timeZone: string,
): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`invalid date: ${isoDate}`);
  }

  const guess = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  const offsetAtGuess = zoneOffsetMilliseconds(new Date(guess), timeZone);
  const corrected = guess - offsetAtGuess;

  const offsetAtCorrected = zoneOffsetMilliseconds(new Date(corrected), timeZone);
  return new Date(guess - offsetAtCorrected);
}

/** How far ahead of UTC the zone is, at a particular instant, in milliseconds. */
function zoneOffsetMilliseconds(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );

  return asUtc - at.getTime();
}

/**
 * The dark window for the night beginning on `isoDate` at the site.
 *
 * Null when the Sun never reaches -18 -- a white night. It does not happen at
 * Tbilisi's latitude, but the observatory's coordinates are configuration and
 * this returns an honest "no darkness" rather than an empty window that reads
 * like a bug.
 */
export function nightWindow(
  isoDate: string,
  timeZone: string,
  site: Site,
): NightWindow | null {
  const observer = new Observer(
    site.latitudeDegrees,
    site.longitudeDegrees,
    site.elevationMetres ?? 0,
  );

  // Search from local noon so the window found is unambiguously the night that
  // starts on this date, rather than the tail of the previous one.
  const noon = localWallClockToUtc(isoDate, 12, timeZone);

  const dusk = SearchAltitude(
    Body.Sun,
    observer,
    -1,
    MakeTime(noon),
    1,
    ASTRONOMICAL_DARKNESS_DEGREES,
  );
  if (!dusk) return null;

  const dawn = SearchAltitude(
    Body.Sun,
    observer,
    +1,
    dusk,
    1,
    ASTRONOMICAL_DARKNESS_DEGREES,
  );
  if (!dawn) return null;

  return { duskAt: dusk.date, dawnAt: dawn.date };
}
