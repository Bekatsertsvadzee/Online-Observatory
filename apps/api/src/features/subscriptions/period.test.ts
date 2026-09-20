import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { nextPeriodEnd } from "@darkview/db/subscriptions";

/**
 * A billing month is a month in the customer's calendar, not in UTC.
 *
 * `nextPeriodEnd` used to clamp in UTC. Customers live in Asia/Tbilisi, UTC+4 and
 * no DST, so a subscription taken between 00:00 and 04:00 local is the previous
 * day in UTC -- and a UTC calendar renewed it on days the customer never chose.
 * One worked example, then the property across four years of anchors.
 */
const TBILISI_OFFSET_MS = 4 * 3_600_000;

function localDay(moment: Date): number {
  return new Date(moment.getTime() + TBILISI_OFFSET_MS).getUTCDate();
}

function localDaysInMonth(moment: Date): number {
  const local = new Date(moment.getTime() + TBILISI_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
}

describe("subscription periods in the customer's calendar", () => {
  it("renews on the 1st every month for a subscription taken at 02:00 on Feb 1, Tbilisi", () => {
    let end = new Date("2027-01-31T22:00:00.000Z"); // 2027-02-01 02:00 Tbilisi
    const days: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      end = nextPeriodEnd(end);
      days.push(localDay(end));
    }
    expect(days).toEqual([1, 1, 1]);
  });

  it("each renewal keeps the anchor's local day, clamped to the local month", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2030, 0, 1) }),
        (ms) => {
          const from = new Date(ms);
          const end = nextPeriodEnd(from);
          expect(end.getTime()).toBeGreaterThan(from.getTime());
          expect(localDay(end)).toBe(Math.min(localDay(from), localDaysInMonth(end)));
        },
      ),
      { numRuns: 2000 },
    );
  });
});
