import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openMeteoSource, parseOpenMeteo } from "@/conditions/open-meteo";

/**
 * The fixture is a real response, recorded on 2026-09-16 from
 * https://api.open-meteo.com/v1/forecast?latitude=41.7151&longitude=44.8271
 *   &hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,
 *   precipitation_probability,relative_humidity_2m,wind_speed_10m
 *   &forecast_days=2&timeformat=unixtime&wind_speed_unit=ms
 * and kept verbatim. No test calls the API.
 */
const recorded: unknown = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "fixtures/open-meteo-tbilisi-2026-09-16.json"),
    "utf8",
  ),
);

const okResponse = () => new Response(JSON.stringify(recorded), { status: 200 });

describe("reading an Open-Meteo response", () => {
  it("turns the recorded forecast into forty-eight hours, with no seeing", () => {
    const hours = parseOpenMeteo(recorded);

    expect(hours).toHaveLength(48);
    expect(hours[0]).toEqual({
      at: new Date("2026-09-16T00:00:00.000Z"),
      cloudCoverPercent: 100,
      cloudCoverLowPercent: 70,
      cloudCoverMidPercent: 81,
      cloudCoverHighPercent: 100,
      precipitationProbabilityPercent: 0,
      relativeHumidityPercent: 75,
      windSpeedMetresPerSecond: 3.13,
      seeingArcseconds: null,
    });
    expect(hours[1].at.getTime() - hours[0].at.getTime()).toBe(3_600_000);
    expect(hours.every((hour) => hour.seeingArcseconds === null)).toBe(true);
  });

  it("refuses a response whose series disagree in length", () => {
    const body = structuredClone(recorded) as { hourly: { cloud_cover_low: number[] } };
    body.hourly.cloud_cover_low.pop();
    expect(() => parseOpenMeteo(body)).toThrow(/cloud_cover_low/);
  });

  it("refuses a response missing a series", () => {
    const body = structuredClone(recorded) as { hourly: Record<string, unknown> };
    delete body.hourly.wind_speed_10m;
    expect(() => parseOpenMeteo(body)).toThrow();
  });
});

describe("asking Open-Meteo", () => {
  it("uses the keyless endpoint without a key", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await openMeteoSource({ fetchImpl }).fetchHours({ latitude: 41.72, longitude: 44.83 });

    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.origin).toBe("https://api.open-meteo.com");
    expect(url.searchParams.get("latitude")).toBe("41.72");
    expect(url.searchParams.get("longitude")).toBe("44.83");
    expect(url.searchParams.get("timeformat")).toBe("unixtime");
    expect(url.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(url.searchParams.has("apikey")).toBe(false);
  });

  it("uses the commercial endpoint with a key", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await openMeteoSource({ apiKey: "key-123", fetchImpl }).fetchHours({
      latitude: 41.72,
      longitude: 44.83,
    });

    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.origin).toBe("https://customer-api.open-meteo.com");
    expect(url.searchParams.get("apikey")).toBe("key-123");
  });

  it("fails on an error status without repeating the key", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota", { status: 429 }));
    const failure = openMeteoSource({ apiKey: "key-123", fetchImpl }).fetchHours({
      latitude: 41.72,
      longitude: 44.83,
    });

    await expect(failure).rejects.toThrow("open-meteo answered 429");
    await expect(failure).rejects.not.toThrow(/key-123/);
  });
});
