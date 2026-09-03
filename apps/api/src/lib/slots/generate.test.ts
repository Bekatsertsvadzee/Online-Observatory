import { describe, expect, it } from "vitest";

import { zSlot, zSlotList } from "@darkview/contracts/zod";

import { nightWindow } from "@/lib/slots/darkness";
import {
  generateSlots,
  PROVISIONAL_SLOT_PRICE_MINOR,
  SLOT_DURATION_MINUTES,
  SLOT_TURNAROUND_MINUTES,
  type SlotAvailabilityInput,
} from "@/lib/slots/generate";

const site = { latitudeDegrees: 41.7151, longitudeDegrees: 44.8271 };
const window = nightWindow("2026-12-21", "Asia/Tbilisi", site)!;

/** Well before the window, so nothing is in the past unless a test says so. */
const beforeTheNight = new Date("2026-12-21T00:00:00Z");

function slots(overrides: Partial<SlotAvailabilityInput> = {}) {
  return generateSlots({
    window,
    now: beforeTheNight,
    observatory: { online: true, weatherHold: false },
    bookedStartAt: new Set<number>(),
    ...overrides,
  });
}

describe("slots tile the dark window", () => {
  it("emits slots, all inside darkness", () => {
    const generated = slots();
    expect(generated.length).toBeGreaterThan(0);

    for (const slot of generated) {
      expect(new Date(slot.startAt).getTime()).toBeGreaterThanOrEqual(
        window.duskAt.getTime(),
      );
      expect(new Date(slot.endAt).getTime()).toBeLessThanOrEqual(
        window.dawnAt.getTime(),
      );
    }
  });

  it("never offers a slot that would run past dawn", () => {
    const last = slots().at(-1)!;
    const wouldOverrun =
      new Date(last.startAt).getTime() +
      (SLOT_DURATION_MINUTES + SLOT_TURNAROUND_MINUTES) * 60_000 +
      SLOT_DURATION_MINUTES * 60_000;

    expect(wouldOverrun).toBeGreaterThan(window.dawnAt.getTime());
  });

  it("leaves the turnaround gap between consecutive slots", () => {
    const generated = slots();
    for (let i = 1; i < generated.length; i += 1) {
      const gapMinutes =
        (new Date(generated[i].startAt).getTime() -
          new Date(generated[i - 1].endAt).getTime()) /
        60_000;
      expect(gapMinutes).toBe(SLOT_TURNAROUND_MINUTES);
    }
  });

  it("gives midwinter more slots than midsummer", () => {
    const summer = generateSlots({
      window: nightWindow("2026-06-21", "Asia/Tbilisi", site)!,
      now: new Date("2026-06-21T00:00:00Z"),
      observatory: { online: true, weatherHold: false },
      bookedStartAt: new Set<number>(),
    });

    expect(slots().length).toBeGreaterThan(summer.length);
  });

  it("produces slots the contract's own schema accepts", () => {
    for (const slot of slots()) expect(() => zSlot.parse(slot)).not.toThrow();
    expect(() =>
      zSlotList.parse({ date: "2026-12-21", items: slots() }),
    ).not.toThrow();
  });
});

// criterion 2
describe("a slot in the past is never available", () => {
  it("marks every slot before now as IN_THE_PAST", () => {
    const midNight = new Date(
      (window.duskAt.getTime() + window.dawnAt.getTime()) / 2,
    );
    const generated = slots({ now: midNight });

    const past = generated.filter(
      (slot) => new Date(slot.startAt).getTime() <= midNight.getTime(),
    );

    expect(past.length).toBeGreaterThan(0);
    for (const slot of past) {
      expect(slot.available).toBe(false);
      expect(slot.unavailableReason).toBe("IN_THE_PAST");
    }
  });

  it("leaves nothing available once the whole night has passed", () => {
    const generated = slots({ now: new Date("2026-12-22T12:00:00Z") });
    expect(generated.every((slot) => !slot.available)).toBe(true);
    expect(generated.every((slot) => slot.unavailableReason === "IN_THE_PAST")).toBe(
      true,
    );
  });
});

// criterion 3
describe("site state closes the night", () => {
  it("returns every slot unavailable with WEATHER_HOLD during a hold", () => {
    const generated = slots({
      observatory: { online: true, weatherHold: true },
    });

    expect(generated.length).toBeGreaterThan(0);
    for (const slot of generated) {
      expect(slot.available).toBe(false);
      expect(slot.unavailableReason).toBe("WEATHER_HOLD");
    }
  });

  it("reports OBSERVATORY_OFFLINE when the observatory is down", () => {
    const generated = slots({
      observatory: { online: false, weatherHold: false },
    });
    expect(generated.every((s) => s.unavailableReason === "OBSERVATORY_OFFLINE")).toBe(
      true,
    );
  });

  it("marks a taken slot ALREADY_BOOKED without affecting its neighbours", () => {
    const all = slots();
    const taken = new Date(all[2].startAt).getTime();
    const generated = slots({ bookedStartAt: new Set([taken]) });

    expect(generated[2].available).toBe(false);
    expect(generated[2].unavailableReason).toBe("ALREADY_BOOKED");
    expect(generated[1].available).toBe(true);
    expect(generated[3].available).toBe(true);
  });

  it("prefers the more specific reason when several apply", () => {
    const all = slots();
    const taken = new Date(all[2].startAt).getTime();
    const generated = slots({
      bookedStartAt: new Set([taken]),
      observatory: { online: false, weatherHold: true },
    });

    // Already booked is specific to the slot; the site-wide reasons are not.
    expect(generated[2].unavailableReason).toBe("ALREADY_BOOKED");
    expect(generated[3].unavailableReason).toBe("WEATHER_HOLD");
  });

  it("never reports available alongside a reason", () => {
    for (const observatory of [
      { online: true, weatherHold: false },
      { online: true, weatherHold: true },
      { online: false, weatherHold: false },
    ]) {
      for (const slot of slots({ observatory })) {
        expect(slot.available).toBe(slot.unavailableReason === null);
      }
    }
  });
});

// criterion 4
describe("money is integer minor units", () => {
  it("prices every slot as a whole number of tetri", () => {
    for (const slot of slots()) {
      expect(Number.isInteger(slot.priceMinor)).toBe(true);
      expect(slot.priceMinor).toBeGreaterThanOrEqual(0);
      expect(slot.currency).toBe("GEL");
    }
  });

  it("keeps the price itself an integer constant", () => {
    expect(Number.isInteger(PROVISIONAL_SLOT_PRICE_MINOR)).toBe(true);
  });
});

describe("slot times are presentable", () => {
  it("starts every slot on a five-minute boundary with no stray seconds", () => {
    for (const slot of slots()) {
      const start = new Date(slot.startAt);
      expect(start.getUTCSeconds()).toBe(0);
      expect(start.getUTCMilliseconds()).toBe(0);
      expect(start.getUTCMinutes() % 5).toBe(0);
    }
  });

  it("never starts a slot before darkness by rounding down", () => {
    for (const slot of slots()) {
      expect(new Date(slot.startAt).getTime()).toBeGreaterThanOrEqual(
        window.duskAt.getTime(),
      );
    }
  });
});
