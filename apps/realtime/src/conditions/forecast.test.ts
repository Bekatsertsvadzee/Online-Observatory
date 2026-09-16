import { describe, expect, it, vi } from "vitest";

import {
  coarseSite,
  firstAvailableForecast,
  type ForecastHour,
  type ForecastSource,
} from "@/conditions/forecast";

const SITE = { latitude: 41.715123, longitude: 44.827149 };

const hour: ForecastHour = {
  at: new Date("2026-09-16T18:00:00.000Z"),
  cloudCoverPercent: 10,
  cloudCoverLowPercent: 0,
  cloudCoverMidPercent: 5,
  cloudCoverHighPercent: 10,
  precipitationProbabilityPercent: 0,
  relativeHumidityPercent: 60,
  windSpeedMetresPerSecond: 2,
  seeingArcseconds: 1.2,
};

const answering = (name: ForecastSource["name"], hours = [hour]): ForecastSource => ({
  name,
  fetchHours: vi.fn(async () => hours),
});

const failing = (name: ForecastSource["name"]): ForecastSource => ({
  name,
  fetchHours: vi.fn(async () => {
    throw new Error("down");
  }),
});

describe("choosing a forecast source", () => {
  it("takes the first source that answers, and asks no further", async () => {
    const meteoblue = answering("METEOBLUE");
    const openMeteo = answering("OPEN_METEO");

    const result = await firstAvailableForecast([meteoblue, openMeteo], SITE);

    expect(result.forecast?.source).toBe("METEOBLUE");
    expect(openMeteo.fetchHours).not.toHaveBeenCalled();
  });

  it("falls back to Open-Meteo when meteoblue fails", async () => {
    const result = await firstAvailableForecast(
      [failing("METEOBLUE"), answering("OPEN_METEO")],
      SITE,
    );

    expect(result.forecast).toEqual({ source: "OPEN_METEO", hours: [hour] });
    expect(result.failures).toEqual(["METEOBLUE: down"]);
  });

  it("falls back when a source answers with no hours", async () => {
    const result = await firstAvailableForecast(
      [answering("METEOBLUE", []), answering("OPEN_METEO")],
      SITE,
    );

    expect(result.forecast?.source).toBe("OPEN_METEO");
    expect(result.failures).toEqual(["METEOBLUE: no hours"]);
  });

  it("reports nothing, never a guess, when every source fails", async () => {
    const result = await firstAvailableForecast(
      [failing("METEOBLUE"), failing("OPEN_METEO")],
      SITE,
    );

    expect(result.forecast).toBeNull();
    expect(result.failures).toHaveLength(2);
  });

  it("sends a provider coordinates to about a kilometre, not the telescope's position", async () => {
    const source = answering("OPEN_METEO");
    await firstAvailableForecast([source], SITE);

    expect(source.fetchHours).toHaveBeenCalledWith({ latitude: 41.72, longitude: 44.83 });
    expect(coarseSite({ latitude: -33.4567, longitude: -70.6649 })).toEqual({
      latitude: -33.46,
      longitude: -70.66,
    });
  });
});
