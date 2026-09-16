import { z } from "zod";

import type { ForecastHour, ForecastSource } from "@/conditions/forecast";

/**
 * Open-Meteo, the DV-110 fallback: no seeing, cloud layers split at 3 km and 8 km.
 *
 * **The keyless endpoint is for non-commercial use only** (open-meteo.com/en/pricing).
 * With `apiKey` set, requests go to the commercial `customer-api` host instead.
 */

const HOURLY = [
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "precipitation_probability",
  "relative_humidity_2m",
  "wind_speed_10m",
] as const;

/** Today and tomorrow in UTC, which covers the rest of tonight at any hour. */
const FORECAST_DAYS = 2;

const REQUEST_TIMEOUT_MS = 10_000;

const series = z.array(z.number().nullable());

const responseSchema = z.object({
  hourly: z.object({
    time: z.array(z.number().int()),
    cloud_cover: series,
    cloud_cover_low: series,
    cloud_cover_mid: series,
    cloud_cover_high: series,
    precipitation_probability: series,
    relative_humidity_2m: series,
    wind_speed_10m: series,
  }),
});

/** A response body, requested with `timeformat=unixtime` and `wind_speed_unit=ms`. */
export function parseOpenMeteo(body: unknown): ForecastHour[] {
  const { hourly } = responseSchema.parse(body);
  const length = hourly.time.length;
  for (const name of HOURLY) {
    if (hourly[name].length !== length) {
      throw new Error(`open-meteo: ${name} has ${hourly[name].length} values for ${length} hours`);
    }
  }

  return hourly.time.map((seconds, index) => ({
    at: new Date(seconds * 1000),
    cloudCoverPercent: hourly.cloud_cover[index],
    cloudCoverLowPercent: hourly.cloud_cover_low[index],
    cloudCoverMidPercent: hourly.cloud_cover_mid[index],
    cloudCoverHighPercent: hourly.cloud_cover_high[index],
    precipitationProbabilityPercent: hourly.precipitation_probability[index],
    relativeHumidityPercent: hourly.relative_humidity_2m[index],
    windSpeedMetresPerSecond: hourly.wind_speed_10m[index],
    seeingArcseconds: null,
  }));
}

export function openMeteoSource(options: {
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): ForecastSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: "OPEN_METEO",
    async fetchHours(site) {
      const url = new URL(
        options.apiKey
          ? "https://customer-api.open-meteo.com/v1/forecast"
          : "https://api.open-meteo.com/v1/forecast",
      );
      url.searchParams.set("latitude", String(site.latitude));
      url.searchParams.set("longitude", String(site.longitude));
      url.searchParams.set("hourly", HOURLY.join(","));
      url.searchParams.set("forecast_days", String(FORECAST_DAYS));
      url.searchParams.set("timeformat", "unixtime");
      url.searchParams.set("wind_speed_unit", "ms");
      if (options.apiKey) url.searchParams.set("apikey", options.apiKey);

      const response = await fetchImpl(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // The status only: the URL carries the key when one is set.
      if (!response.ok) throw new Error(`open-meteo answered ${response.status}`);
      return parseOpenMeteo(await response.json());
    },
  };
}
