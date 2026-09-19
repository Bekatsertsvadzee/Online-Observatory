import { describe, expect, it } from "vitest";

import { nextPeriodEnd } from "@darkview/db/subscriptions";

/**
 * ADR-022. A period is a calendar month, and the renewal the sweep opens has to
 * land on the day the expiry it replaces falls due -- so this is arithmetic the
 * money depends on, not a formatting detail.
 */
describe("a subscription period", () => {
  it("is one calendar month, keeping the day and the time of day", () => {
    expect(nextPeriodEnd(new Date("2026-12-15T12:00:00.000Z")).toISOString()).toBe(
      "2027-01-15T12:00:00.000Z",
    );
    expect(nextPeriodEnd(new Date("2026-01-03T21:30:00.000Z")).toISOString()).toBe(
      "2026-02-03T21:30:00.000Z",
    );
  });

  it("clamps to the end of a shorter month instead of overflowing into the next", () => {
    // The overflow this guards against is `setUTCMonth(+1)` answering 3 March,
    // which would skip February and charge for it twice.
    expect(nextPeriodEnd(new Date("2027-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2027-02-28T00:00:00.000Z",
    );
    expect(nextPeriodEnd(new Date("2028-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
    expect(nextPeriodEnd(new Date("2026-03-31T00:00:00.000Z")).toISOString()).toBe(
      "2026-04-30T00:00:00.000Z",
    );
  });

  it("always moves forward, and never by more than a month", () => {
    for (let day = 1; day <= 31; day += 1) {
      const from = new Date(Date.UTC(2027, 0, day, 9, 0, 0));
      const end = nextPeriodEnd(from);
      expect(end.getTime()).toBeGreaterThan(from.getTime());
      expect(end.getTime() - from.getTime()).toBeLessThanOrEqual(31 * 24 * 3600 * 1000);
    }
  });
});
