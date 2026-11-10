import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { pointsEarnedFor, tierFor, type LoyaltyScheme, type LoyaltyTier } from "@darkview/db/loyalty";

import { localWallClockToUtc } from "@/lib/slots/darkness";
import {
  clashesWithHeld,
  generateSlots,
  isSessionLength,
  PROVISIONAL_SLOT_PRICE_MINOR,
  SESSION_MAX_MINUTES,
  SESSION_MIN_MINUTES,
  SESSION_STEP_MINUTES,
  SLOT_ALIGNMENT_MINUTES,
  SLOT_TURNAROUND_MINUTES,
  sessionPriceMinor,
} from "@/lib/slots/generate";

vi.mock("server-only", () => ({}));
const { closeRefundMinor } = await import("@/features/missions/close-refund");

/**
 * Security review 2026-11-07, step 4: the slot, pricing and loyalty arithmetic held to
 * properties across generated inputs, not only to the worked examples beside each
 * function. Nothing here touches a database.
 */

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 0, 1);

const sessionLength = fc
  .integer({ min: SESSION_MIN_MINUTES / SESSION_STEP_MINUTES, max: SESSION_MAX_MINUTES / SESSION_STEP_MINUTES })
  .map((steps) => steps * SESSION_STEP_MINUTES);

const instant = fc.integer({ min: 0, max: 400 * 24 * 60 }).map((minutes) => BASE + minutes * MINUTE);

const held = fc.record({
  slotStartAt: instant.map((ms) => new Date(ms)),
  durationMinutes: sessionLength,
});

describe("slot generation", () => {
  const window = fc
    .tuple(instant, fc.integer({ min: 0, max: 14 * 60 }), fc.integer({ min: 0, max: 59_999 }))
    .map(([dusk, lengthMinutes, jitter]) => ({
      duskAt: new Date(dusk + jitter),
      dawnAt: new Date(dusk + jitter + lengthMinutes * MINUTE),
    }));

  it("offers only aligned starts that fit wholly inside darkness, at the asked length", () => {
    fc.assert(
      fc.property(window, sessionLength, fc.array(held, { maxLength: 6 }), (night, minutes, bookings) => {
        const slots = generateSlots({
          observatoryId: "obs",
          window: night,
          now: new Date(BASE - MINUTE),
          observatory: { online: true, weatherHold: false },
          held: bookings,
          durationMinutes: minutes,
        });
        for (const slot of slots) {
          const start = Date.parse(slot.startAt);
          const end = Date.parse(slot.endAt);
          expect(start % (SLOT_ALIGNMENT_MINUTES * MINUTE)).toBe(0);
          expect(start).toBeGreaterThanOrEqual(night.duskAt.getTime());
          expect(end).toBeLessThanOrEqual(night.dawnAt.getTime());
          expect(end - start).toBe(minutes * MINUTE);
          expect(slot.priceMinor).toBe(sessionPriceMinor(minutes));
          // Available means clear of every held booking and its turnaround.
          if (slot.available) expect(clashesWithHeld(start, minutes, bookings)).toBe(false);
        }
      }),
    );
  });

  it("never calls a slot available before now", () => {
    fc.assert(
      fc.property(window, instant, (night, now) => {
        const slots = generateSlots({
          observatoryId: "obs",
          window: night,
          now: new Date(now),
          observatory: { online: true, weatherHold: false },
          held: [],
        });
        for (const slot of slots) {
          if (Date.parse(slot.startAt) <= now) expect(slot.available).toBe(false);
        }
      }),
    );
  });
});

describe("the clash rule", () => {
  it("is symmetric: A clashes with B exactly when B clashes with A", () => {
    fc.assert(
      fc.property(held, held, (a, b) => {
        expect(clashesWithHeld(a.slotStartAt.getTime(), a.durationMinutes, [b])).toBe(
          clashesWithHeld(b.slotStartAt.getTime(), b.durationMinutes, [a]),
        );
      }),
    );
  });

  it("holds the turnaround on both sides and frees the minute after it", () => {
    fc.assert(
      fc.property(held, sessionLength, (booking, minutes) => {
        const start = booking.slotStartAt.getTime();
        const heldEnd = start + (booking.durationMinutes + SLOT_TURNAROUND_MINUTES) * MINUTE;
        expect(clashesWithHeld(heldEnd - MINUTE, minutes, [booking])).toBe(true);
        expect(clashesWithHeld(heldEnd, minutes, [booking])).toBe(false);
        const before = start - (minutes + SLOT_TURNAROUND_MINUTES) * MINUTE;
        expect(clashesWithHeld(before, minutes, [booking])).toBe(false);
        expect(clashesWithHeld(before + MINUTE, minutes, [booking])).toBe(true);
      }),
    );
  });
});

describe("prices", () => {
  it("are whole, positive, monotonic in length and never above the per-minute rate", () => {
    fc.assert(
      fc.property(sessionLength, sessionLength, (a, b) => {
        expect(isSessionLength(a)).toBe(true);
        expect(Number.isSafeInteger(sessionPriceMinor(a))).toBe(true);
        expect(sessionPriceMinor(a)).toBeGreaterThan(0);
        if (a <= b) expect(sessionPriceMinor(a)).toBeLessThanOrEqual(sessionPriceMinor(b));
        expect(sessionPriceMinor(a) * 30).toBeLessThanOrEqual(PROVISIONAL_SLOT_PRICE_MINOR * a);
      }),
    );
  });

  it("refund for a close never exceeds the price and never goes negative", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 10_000_000 }),
        instant,
        instant,
        instant,
        (priceMinor, paid, closed, expires) => {
          const refund = closeRefundMinor({
            priceMinor,
            paidAt: new Date(paid),
            closedAt: new Date(closed),
            expiresAt: new Date(expires),
          });
          expect(Number.isSafeInteger(refund)).toBe(true);
          expect(refund).toBeGreaterThanOrEqual(0);
          expect(refund).toBeLessThanOrEqual(Math.max(priceMinor, 0));
        },
      ),
    );
  });
});

describe("loyalty arithmetic", () => {
  const scheme = fc.record({
    pointsPerGel: fc.integer({ min: 0, max: 1_000 }),
    pointsPerGelRedeemed: fc.integer({ min: 1, max: 1_000 }),
    welcomeBonusPoints: fc.constant(0),
    referralBonusPoints: fc.constant(0),
    minimumPayableMinor: fc.integer({ min: 0, max: 10_000 }),
    progressMarkers: fc.constant([]),
  }) as fc.Arbitrary<LoyaltyScheme>;

  it("earns whole, non-negative points that never exceed the rate", () => {
    fc.assert(
      fc.property(scheme, fc.integer({ min: 0, max: 100_000_000 }), (rates, amountMinor) => {
        const points = pointsEarnedFor(rates, amountMinor);
        expect(Number.isSafeInteger(points)).toBe(true);
        expect(points).toBeGreaterThanOrEqual(0);
        expect(points * 100).toBeLessThanOrEqual(amountMinor * rates.pointsPerGel);
      }),
    );
  });

  it("puts every balance in the highest tier it has reached, and a negative one in the first", () => {
    const tiers = fc
      .uniqueArray(fc.integer({ min: 1, max: 100_000 }), { maxLength: 5 })
      .map((thresholds) =>
        [0, ...thresholds.sort((a, b) => a - b)].map(
          (thresholdPoints, index): LoyaltyTier => ({
            code: `T${index}`,
            nameEn: `T${index}`,
            nameKa: `T${index}`,
            thresholdPoints,
            discountPercent: index,
          }),
        ),
      );
    fc.assert(
      fc.property(tiers, fc.integer({ min: -1_000_000, max: 1_000_000 }), (ladder, points) => {
        const tier = tierFor(ladder, points);
        expect(tier.thresholdPoints).toBeLessThanOrEqual(Math.max(points, 0));
        const next = ladder.find((candidate) => candidate.thresholdPoints > tier.thresholdPoints);
        if (next) expect(next.thresholdPoints).toBeGreaterThan(Math.max(points, 0));
      }),
    );
  });
});

describe("wall-clock conversion", () => {
  // Asia/Tbilisi has no DST; the zones beside it do, and the conversion must not
  // quietly break for the next site (darkness.ts).
  const zones = fc.constantFrom("Asia/Tbilisi", "Europe/Berlin", "America/New_York", "UTC");
  const date = fc
    .integer({ min: 0, max: 3 * 366 })
    .map((days) => new Date(BASE + days * 86_400_000).toISOString().slice(0, 10));

  it("lands on the asked hour of the asked local date, wherever the hour exists", () => {
    fc.assert(
      fc.property(zones, date, fc.integer({ min: 0, max: 23 }), (timeZone, isoDate, hour) => {
        const instantUtc = localWallClockToUtc(isoDate, hour, timeZone);
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
        }).formatToParts(instantUtc);
        const read = (type: string) => parts.find((part) => part.type === type)!.value;
        const localDate = `${read("year")}-${read("month")}-${read("day")}`;
        const localHour = Number(read("hour"));
        // A spring-forward gap hour does not exist locally and lands an hour later.
        const skipped = localHour === hour + 1 && localDate === isoDate;
        if (!skipped) {
          expect(localDate).toBe(isoDate);
          expect(localHour).toBe(hour);
        }
        if (timeZone === "Asia/Tbilisi") {
          expect(instantUtc.getTime()).toBe(Date.parse(`${isoDate}T00:00:00Z`) + (hour - 4) * 3_600_000);
        }
      }),
    );
  });
});
