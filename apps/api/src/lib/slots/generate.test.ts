import { describe, expect, it } from "vitest";

import { zSlot, zSlotList } from "@darkview/contracts/zod";

import { TURNAROUND_MINUTES } from "@darkview/db/waitlist";

import { nightWindow } from "@/lib/slots/darkness";
import {
  clashesWithHeld,
  generateSlots,
  isSessionLength,
  PROVISIONAL_SLOT_PRICE_MINOR,
  sessionPriceMinor,
  SLOT_DURATION_MINUTES,
  SLOT_STRIDE_MINUTES,
  SLOT_TURNAROUND_MINUTES,
  type SlotAvailabilityInput,
} from "@/lib/slots/generate";

const site = { latitudeDegrees: 41.7151, longitudeDegrees: 44.8271 };
const window = nightWindow("2026-12-21", "Asia/Tbilisi", site)!;

/** Well before the window, so nothing is in the past unless a test says so. */
const beforeTheNight = new Date("2026-12-21T00:00:00Z");

const observatoryId = "00000000-0000-4000-8000-000000000010";

function slots(overrides: Partial<SlotAvailabilityInput> = {}) {
  return generateSlots({
    observatoryId,
    window,
    now: beforeTheNight,
    observatory: { online: true, weatherHold: false },
    held: [],
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
    const next =
      new Date(last.startAt).getTime() +
      SLOT_STRIDE_MINUTES * 60_000 +
      SLOT_DURATION_MINUTES * 60_000;

    expect(next).toBeGreaterThan(window.dawnAt.getTime());
  });

  it("offers a start every fifteen minutes, each a thirty-minute session", () => {
    expect(SLOT_STRIDE_MINUTES).toBe(15);
    const generated = slots();
    for (let i = 1; i < generated.length; i += 1) {
      const strideMinutes =
        (Date.parse(generated[i].startAt) - Date.parse(generated[i - 1].startAt)) / 60_000;
      expect(strideMinutes).toBe(SLOT_STRIDE_MINUTES);
    }
    for (const slot of generated) {
      expect(slot.durationMinutes).toBe(30);
      expect((Date.parse(slot.endAt) - Date.parse(slot.startAt)) / 60_000).toBe(30);
    }
  });

  it("gives midwinter more slots than midsummer", () => {
    const summer = generateSlots({
      observatoryId,
      window: nightWindow("2026-06-21", "Asia/Tbilisi", site)!,
      now: new Date("2026-06-21T00:00:00Z"),
      observatory: { online: true, weatherHold: false },
      held: [],
    });

    expect(slots().length).toBeGreaterThan(summer.length);
  });

  it("produces slots the contract's own schema accepts", () => {
    for (const slot of slots()) expect(() => zSlot.parse(slot)).not.toThrow();
    expect(() =>
      zSlotList.parse({ observatoryId, date: "2026-12-21", items: slots() }),
    ).not.toThrow();
  });

  // ADR-015: a slot is time on one telescope, and says which.
  it("stamps every slot with the observatory it belongs to", () => {
    const generated = slots();
    expect(generated.length).toBeGreaterThan(0);
    for (const slot of generated) expect(slot.observatoryId).toBe(observatoryId);
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
    const held = [{ slotStartAt: new Date(all[2].startAt), durationMinutes: 30 }];
    const generated = slots({ held });

    expect(generated[2].available).toBe(false);
    expect(generated[2].unavailableReason).toBe("ALREADY_BOOKED");
    expect(generated[1].unavailableReason).toBe("ALREADY_BOOKED");
    expect(generated[3].unavailableReason).toBe("ALREADY_BOOKED");
  });

  it("prefers the more specific reason when several apply", () => {
    const all = slots();
    const held = [{ slotStartAt: new Date(all[2].startAt), durationMinutes: 30 }];
    const generated = slots({
      held,
      observatory: { online: false, weatherHold: true },
    });

    // Already booked is specific to the slot; the site-wide reasons are not.
    expect(generated[2].unavailableReason).toBe("ALREADY_BOOKED");
    expect(generated[6].unavailableReason).toBe("WEATHER_HOLD");
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
  it("starts every slot on a quarter hour of the observatory's clock", () => {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Tbilisi",
      minute: "2-digit",
      second: "2-digit",
    });
    for (const slot of slots()) {
      const start = new Date(slot.startAt);
      expect(start.getUTCSeconds()).toBe(0);
      expect(start.getUTCMilliseconds()).toBe(0);
      const [minute, second] = local.format(start).split(":").map(Number);
      expect(second).toBe(0);
      expect([0, 15, 30, 45]).toContain(minute);
    }
  });

  it("aligns the first start forward to the next quarter hour after dusk", () => {
    const first = Date.parse(slots()[0].startAt);
    const quarter = 15 * 60_000;
    expect(first).toBe(Math.ceil(window.duskAt.getTime() / quarter) * quarter);
  });

  it("starts at dusk itself when dusk falls on a quarter hour", () => {
    const dusk = new Date("2026-12-21T15:00:00.000Z");
    const generated = slots({
      window: { duskAt: dusk, dawnAt: new Date("2026-12-21T17:00:00.000Z") },
    });
    expect(generated.map((slot) => slot.startAt.slice(11, 16))).toEqual([
      "15:00",
      "15:15",
      "15:30",
      "15:45",
      "16:00",
      "16:15",
      "16:30",
    ]);
  });

  it("never starts a slot before darkness by rounding down", () => {
    for (const slot of slots()) {
      expect(new Date(slot.startAt).getTime()).toBeGreaterThanOrEqual(
        window.duskAt.getTime(),
      );
    }
  });
});

describe("the turnaround between customers blocks overlapping starts", () => {
  const night = {
    duskAt: new Date("2026-12-21T15:00:00.000Z"),
    dawnAt: new Date("2026-12-21T19:00:00.000Z"),
  };
  const at = (hhmm: string) => new Date(`2026-12-21T${hhmm}:00.000Z`);

  function reasons(held: { slotStartAt: Date; durationMinutes: number }[]) {
    return Object.fromEntries(
      slots({ window: night, held }).map((slot) => [
        slot.startAt.slice(11, 16),
        slot.unavailableReason,
      ]),
    );
  }

  it("blocks every start whose session would come within ten minutes of a held one", () => {
    expect(SLOT_TURNAROUND_MINUTES).toBe(10);
    const byStart = reasons([{ slotStartAt: at("16:30"), durationMinutes: 30 }]);

    // 16:00 would end 16:30, with no turnaround before the held session.
    expect(byStart["15:45"]).toBeNull();
    expect(byStart["16:00"]).toBe("ALREADY_BOOKED");
    expect(byStart["16:15"]).toBe("ALREADY_BOOKED");
    expect(byStart["16:30"]).toBe("ALREADY_BOOKED");
    expect(byStart["16:45"]).toBe("ALREADY_BOOKED");
    // The held session ends 17:00; 17:00 and 17:05 are inside its turnaround.
    expect(byStart["17:00"]).toBe("ALREADY_BOOKED");
    expect(byStart["17:15"]).toBeNull();
  });

  it("reads a held booking that started off the grid, by its own duration", () => {
    const byStart = reasons([{ slotStartAt: at("16:05"), durationMinutes: 60 }]);
    // Held 16:05-17:05, turnaround to 17:15.
    expect(byStart["15:15"]).toBeNull();
    expect(byStart["15:30"]).toBe("ALREADY_BOOKED");
    expect(byStart["17:00"]).toBe("ALREADY_BOOKED");
    expect(byStart["17:15"]).toBeNull();
  });

  it("is symmetric and exact at the boundary", () => {
    const held = [{ slotStartAt: at("16:00"), durationMinutes: 30 }];
    expect(clashesWithHeld(at("16:40").getTime(), 30, held)).toBe(false);
    expect(clashesWithHeld(at("16:39").getTime(), 30, held)).toBe(true);
    expect(clashesWithHeld(at("15:20").getTime(), 30, held)).toBe(false);
    expect(clashesWithHeld(at("15:21").getTime(), 30, held)).toBe(true);
  });
});

describe("a slot offered to its waitlist (clients ADR-068)", () => {
  it("is HELD_FOR_WAITLIST to everyone the offer is not for, and its neighbours stay open", () => {
    const all = slots();
    const offered = all[8];
    const marked = slots({
      offers: [{ slotStartAt: new Date(offered.startAt), durationMinutes: SLOT_DURATION_MINUTES }],
    });
    expect(marked[8]).toMatchObject({ available: false, unavailableReason: "HELD_FOR_WAITLIST" });
    expect(marked[2].available).toBe(true);
    expect(marked[14].available).toBe(true);
  });

  it("still says ALREADY_BOOKED where a booking holds the slot as well", () => {
    const start = new Date(slots()[8].startAt);
    const marked = slots({
      held: [{ slotStartAt: start, durationMinutes: SLOT_DURATION_MINUTES }],
      offers: [{ slotStartAt: start, durationMinutes: SLOT_DURATION_MINUTES }],
    });
    expect(marked[8].unavailableReason).toBe("ALREADY_BOOKED");
  });

  it("uses the exclusion constraint's turnaround, as the waitlist does", () => {
    expect(SLOT_TURNAROUND_MINUTES).toBe(TURNAROUND_MINUTES);
  });
});

describe("every slot carries a forecast (clients ADR-068)", () => {
  it("is UNKNOWN when nothing is read", () => {
    for (const slot of slots()) {
      expect(slot.forecast).toEqual({ status: "UNKNOWN", cloudCoverPercent: null });
    }
  });

  it("is what the reader answers for the slot's own span", () => {
    const spans: [number, number][] = [];
    const generated = slots({
      forecastFor: (startMs, endMs) => {
        spans.push([startMs, endMs]);
        return { status: "KNOWN", cloudCoverPercent: 20 };
      },
    });
    expect(generated[0].forecast).toEqual({ status: "KNOWN", cloudCoverPercent: 20 });
    expect(spans[0]).toEqual([
      Date.parse(generated[0].startAt),
      Date.parse(generated[0].endAt),
    ]);
    expect(zSlotList.parse({ observatoryId, date: "2026-12-21", items: generated }).items).toHaveLength(
      generated.length,
    );
  });
});

describe("a session of any quarter hour from 15 minutes to 4 hours (clients ADR-072)", () => {
  it("accepts exactly the quarter hours from 15 to 240", () => {
    for (const minutes of [15, 30, 45, 60, 90, 135, 240]) {
      expect(isSessionLength(minutes), String(minutes)).toBe(true);
    }
    for (const minutes of [0, 10, 14, 20, 31, 44.5, 255, 300, -15, Number.NaN]) {
      expect(isSessionLength(minutes), String(minutes)).toBe(false);
    }
  });

  it("prices every length at the default length's rate per minute", () => {
    expect(sessionPriceMinor(SLOT_DURATION_MINUTES)).toBe(PROVISIONAL_SLOT_PRICE_MINOR);
    expect(sessionPriceMinor(15)).toBe(2250);
    expect(sessionPriceMinor(45)).toBe(6750);
    expect(sessionPriceMinor(60)).toBe(9000);
    expect(sessionPriceMinor(240)).toBe(36000);
  });

  it("makes every slot as long as asked, priced for its length", () => {
    for (const durationMinutes of [15, 45, 60, 240]) {
      const generated = slots({ durationMinutes });
      expect(generated.length).toBeGreaterThan(0);
      for (const slot of generated) {
        expect(slot.durationMinutes).toBe(durationMinutes);
        expect(Date.parse(slot.endAt) - Date.parse(slot.startAt)).toBe(
          durationMinutes * 60_000,
        );
        expect(slot.priceMinor).toBe(sessionPriceMinor(durationMinutes));
        expect(Date.parse(slot.endAt)).toBeLessThanOrEqual(window.dawnAt.getTime());
        expect(zSlot.safeParse(slot).success).toBe(true);
      }
    }
  });

  it("offers fewer starts for a longer session, still on the quarter-hour grid", () => {
    const half = slots({ durationMinutes: 30 });
    const four = slots({ durationMinutes: 240 });
    expect(four.length).toBe(half.length - (240 - 30) / SLOT_STRIDE_MINUTES);
    expect(four[0].startAt).toBe(half[0].startAt);
  });

  it("blocks every start whose longer session would reach a held booking's turnaround", () => {
    const held = slots()[12];
    const heldStartMs = Date.parse(held.startAt);
    const generated = slots({
      durationMinutes: 60,
      held: [{ slotStartAt: new Date(heldStartMs), durationMinutes: 30 }],
    });
    for (const slot of generated) {
      const startMs = Date.parse(slot.startAt);
      const clashes =
        startMs < heldStartMs + (30 + SLOT_TURNAROUND_MINUTES) * 60_000 &&
        heldStartMs < startMs + (60 + SLOT_TURNAROUND_MINUTES) * 60_000;
      expect(slot.unavailableReason === "ALREADY_BOOKED", slot.startAt).toBe(clashes);
    }
  });
});
