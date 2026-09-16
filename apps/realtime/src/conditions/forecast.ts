import type { PrismaClient } from "@darkview/db";

/**
 * DV-110: viewing conditions, fetched on a schedule and stored.
 *
 * Here because this is the only long-lived process, and the issue forbids a fetch
 * per request. **Advisory only**: nothing in this module reads or writes
 * `WeatherState`. The operator's hold stays authoritative.
 */

export type ForecastSourceName = "METEOBLUE" | "OPEN_METEO";

export type ForecastHour = {
  /** The instant the hour begins. */
  at: Date;
  cloudCoverPercent: number | null;
  cloudCoverLowPercent: number | null;
  cloudCoverMidPercent: number | null;
  cloudCoverHighPercent: number | null;
  precipitationProbabilityPercent: number | null;
  relativeHumidityPercent: number | null;
  windSpeedMetresPerSecond: number | null;
  seeingArcseconds: number | null;
};

export type ForecastSite = { latitude: number; longitude: number };

export type ForecastSource = {
  name: ForecastSourceName;
  fetchHours(site: ForecastSite): Promise<ForecastHour[]>;
};

/** Stored hours older than this are deleted; nothing reads a past night's forecast. */
const RETAIN_PAST_HOURS = 48;

/**
 * Coordinates as they leave for a provider: two decimals, about a kilometre.
 *
 * A partner's telescope sits on somebody's property, and its precise position is
 * not a public field (see `listBookableObservatories`). No forecast model resolves
 * finer than this, so nothing is lost by not sending more.
 */
export function coarseSite(site: ForecastSite): ForecastSite {
  return {
    latitude: Math.round(site.latitude * 100) / 100,
    longitude: Math.round(site.longitude * 100) / 100,
  };
}

/**
 * The first source, in order, that answers with hours. Null when every one failed
 * or answered nothing -- which the caller stores as nothing, so those hours age
 * into UNKNOWN rather than being kept as whatever was last known.
 */
export async function firstAvailableForecast(
  sources: readonly ForecastSource[],
  site: ForecastSite,
): Promise<{
  forecast: { source: ForecastSourceName; hours: ForecastHour[] } | null;
  failures: string[];
}> {
  const failures: string[] = [];
  for (const source of sources) {
    try {
      const hours = await source.fetchHours(coarseSite(site));
      if (hours.length > 0) return { forecast: { source: source.name, hours }, failures };
      failures.push(`${source.name}: no hours`);
    } catch (error) {
      failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { forecast: null, failures };
}

/**
 * Refresh the stored forecast for every approved observatory.
 *
 * Approved rather than the API's full bookable rule: a forecast for an approved
 * node that has lost its telescope is harmless, and the API decides who may read
 * one. A DRAFT or suspended node is never fetched for.
 */
export async function refreshViewingConditions(
  database: PrismaClient,
  input: { sources: readonly ForecastSource[]; now: Date },
): Promise<{ refreshed: number; unavailable: number; failures: string[] }> {
  const { sources, now } = input;
  const observatories = await database.observatory.findMany({
    where: { networkNode: { is: { approvalStatus: "APPROVED" } } },
    select: { id: true, latitude: true, longitude: true },
  });

  let refreshed = 0;
  let unavailable = 0;
  const failures: string[] = [];

  for (const observatory of observatories) {
    const result = await firstAvailableForecast(sources, observatory);
    failures.push(...result.failures.map((failure) => `${observatory.id} ${failure}`));
    if (!result.forecast) {
      unavailable += 1;
      continue;
    }

    const { source, hours } = result.forecast;
    // Three statements however many hours a source returns. One upsert per hour held
    // the transaction open long enough to time out on a loaded database.
    await database.$transaction([
      database.viewingForecastHour.deleteMany({
        where: { observatoryId: observatory.id, at: { in: hours.map((hour) => hour.at) } },
      }),
      database.viewingForecastHour.createMany({
        data: hours.map((hour) => ({ ...hour, observatoryId: observatory.id, source, fetchedAt: now })),
      }),
      database.viewingForecastHour.deleteMany({
        where: {
          observatoryId: observatory.id,
          at: { lt: new Date(now.getTime() - RETAIN_PAST_HOURS * 3_600_000) },
        },
      }),
    ]);
    refreshed += 1;
  }

  return { refreshed, unavailable, failures };
}
