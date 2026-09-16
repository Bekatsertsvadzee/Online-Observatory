import "server-only";

import type { ViewingConditions, ViewingConditionsHour } from "@darkview/contracts";

import { findBookableObservatory } from "@/features/booking/observatories";
import { getDatabase } from "@/lib/db/client";
import { openIntervals } from "@/lib/slots/availability";
import { nightWindow } from "@/lib/slots/darkness";

/**
 * Tonight's viewing forecast at one bookable observatory (DV-110).
 *
 * Read from what the realtime service stored; never fetched here. **Advisory
 * only**: this reads no weather hold and changes none.
 */

const HOUR_MS = 3_600_000;

/** The observatory-local calendar date at an instant, as YYYY-MM-DD. */
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function previousDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

const unknownHour = (at: number): ViewingConditionsHour => ({
  at: new Date(at).toISOString(),
  status: "UNKNOWN",
  source: null,
  fetchedAt: null,
  cloudCoverPercent: null,
  cloudCoverLowPercent: null,
  cloudCoverMidPercent: null,
  cloudCoverHighPercent: null,
  precipitationProbabilityPercent: null,
  relativeHumidityPercent: null,
  windSpeedMetresPerSecond: null,
  seeingArcseconds: null,
});

/**
 * Null when the observatory is not bookable, which the route answers with 404.
 *
 * **Tonight** is the night that has not yet reached dawn: at 02:00 local it is the
 * night that began yesterday evening, and from that dawn onward it is the night
 * beginning today. The date is the one `GET /slots` takes for the same night.
 */
export async function readViewingConditions(
  observatoryId: string,
  now: Date,
  maxAgeMinutes: number,
): Promise<ViewingConditions | null> {
  const observatory = await findBookableObservatory(observatoryId);
  if (!observatory) return null;

  const site = { latitudeDegrees: observatory.latitude, longitudeDegrees: observatory.longitude };
  const today = localDate(now, observatory.timezone);
  const yesterday = previousDate(today);
  const lastNight = nightWindow(yesterday, observatory.timezone, site);
  const date = lastNight && now < lastNight.dawnAt ? yesterday : today;
  const night = date === yesterday ? lastNight : nightWindow(today, observatory.timezone, site);

  const empty = { observatoryId: observatory.id, date, items: [] };
  if (!night) return empty;

  // Every hour that overlaps an interval the observatory offers, once each.
  const starts = new Set<number>();
  for (const interval of openIntervals(night, observatory.windows, observatory.timezone)) {
    const first = Math.floor(interval.duskAt.getTime() / HOUR_MS) * HOUR_MS;
    for (let at = first; at < interval.dawnAt.getTime(); at += HOUR_MS) starts.add(at);
  }
  const hours = [...starts].sort((a, b) => a - b);
  if (hours.length === 0) return empty;

  const stored = await getDatabase().viewingForecastHour.findMany({
    where: {
      observatoryId: observatory.id,
      at: { in: hours.map((at) => new Date(at)) },
      fetchedAt: { gte: new Date(now.getTime() - maxAgeMinutes * 60_000) },
    },
  });
  const byHour = new Map(stored.map((row) => [row.at.getTime(), row]));

  return {
    ...empty,
    items: hours.map((at) => {
      const row = byHour.get(at);
      if (!row) return unknownHour(at);
      return {
        at: row.at.toISOString(),
        status: "KNOWN",
        source: row.source,
        fetchedAt: row.fetchedAt.toISOString(),
        cloudCoverPercent: row.cloudCoverPercent,
        cloudCoverLowPercent: row.cloudCoverLowPercent,
        cloudCoverMidPercent: row.cloudCoverMidPercent,
        cloudCoverHighPercent: row.cloudCoverHighPercent,
        precipitationProbabilityPercent: row.precipitationProbabilityPercent,
        relativeHumidityPercent: row.relativeHumidityPercent,
        windSpeedMetresPerSecond: row.windSpeedMetresPerSecond,
        seeingArcseconds: row.seeingArcseconds,
      };
    }),
  };
}
