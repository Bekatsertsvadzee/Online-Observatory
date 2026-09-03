import { describe, expect, it } from "vitest";

import { localWallClockToUtc, nightWindow } from "@/lib/slots/darkness";

// ADR-005: the Tbilisi installation site.
const site = { latitudeDegrees: 41.7151, longitudeDegrees: 44.8271 };
const TIMEZONE = "Asia/Tbilisi";

const hoursBetween = (from: Date, to: Date) =>
  (to.getTime() - from.getTime()) / 3_600_000;

const localTime = (at: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);

describe("local dates become the right instant", () => {
  it("resolves local noon to the site's offset, not the server's", () => {
    // Tbilisi is UTC+4 with no daylight saving, so local noon is 08:00 UTC.
    expect(localWallClockToUtc("2026-09-03", 12, TIMEZONE).toISOString()).toBe(
      "2026-09-03T08:00:00.000Z",
    );
  });

  it("handles a zone that does change offset", () => {
    // London: BST in July, GMT in January. Same wall clock, different instant.
    expect(localWallClockToUtc("2026-07-15", 12, "Europe/London").toISOString()).toBe(
      "2026-07-15T11:00:00.000Z",
    );
    expect(localWallClockToUtc("2026-01-15", 12, "Europe/London").toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
  });

  it("rejects a malformed date rather than guessing", () => {
    expect(() => localWallClockToUtc("not-a-date", 12, TIMEZONE)).toThrow();
  });
});

// criterion 1
describe("darkness follows the sky, not the clock", () => {
  const midsummer = nightWindow("2026-06-21", TIMEZONE, site);
  const midwinter = nightWindow("2026-12-21", TIMEZONE, site);

  it("finds a window on both dates", () => {
    expect(midsummer).not.toBeNull();
    expect(midwinter).not.toBeNull();
  });

  it("gives midwinter far more darkness than midsummer", () => {
    const summerHours = hoursBetween(midsummer!.duskAt, midsummer!.dawnAt);
    const winterHours = hoursBetween(midwinter!.duskAt, midwinter!.dawnAt);

    // Measured at this site: about 4.4 hours in June, about 11.5 in December.
    expect(summerHours).toBeGreaterThan(4);
    expect(summerHours).toBeLessThan(5);
    expect(winterHours).toBeGreaterThan(11);
    expect(winterHours).toBeLessThan(12);

    // The point of the issue: a fixed evening schedule would be wrong by hours.
    expect(winterHours - summerHours).toBeGreaterThan(6);
  });

  it("starts much later in midsummer than in midwinter", () => {
    // Roughly 22:50 local in June against 19:13 in December.
    expect(localTime(midsummer!.duskAt) > "22:00").toBe(true);
    expect(localTime(midwinter!.duskAt) < "20:00").toBe(true);
  });

  it("puts dawn after dusk, on the following morning", () => {
    for (const window of [midsummer!, midwinter!]) {
      expect(window.dawnAt.getTime()).toBeGreaterThan(window.duskAt.getTime());
      expect(hoursBetween(window.duskAt, window.dawnAt)).toBeLessThan(24);
    }
  });

  it("returns the night that begins on the requested date", () => {
    const window = nightWindow("2026-09-03", TIMEZONE, site)!;
    const duskLocalDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
    }).format(window.duskAt);

    expect(duskLocalDate).toBe("2026-09-03");
  });

  it("reports no darkness rather than an empty window above the Arctic Circle", () => {
    // Tromsø in midsummer: the Sun never gets to -18.
    const polar = nightWindow("2026-06-21", "Europe/Oslo", {
      latitudeDegrees: 69.6492,
      longitudeDegrees: 18.9553,
    });
    expect(polar).toBeNull();
  });
});
