import { describe, expect, it } from "vitest";

import { openIntervals, type LocalWindow } from "@/lib/slots/availability";
import type { NightWindow } from "@/lib/slots/darkness";

const TBILISI = "Asia/Tbilisi";

/**
 * One night, stated as instants rather than computed from the sky.
 *
 * Friday 11 September 2026, 21:00 local to 04:00 Saturday. Tbilisi is UTC+4 with
 * no DST, so the arithmetic in these tests is checkable by hand -- which is the
 * point: this file is about intersection, not about astronomy. `darkness.test.ts`
 * is where the Sun's position is held to account.
 */
const NIGHT: NightWindow = {
  duskAt: new Date("2026-09-11T17:00:00Z"), // Fri 21:00 local
  dawnAt: new Date("2026-09-12T00:00:00Z"), // Sat 04:00 local
};

const FRIDAY = 5;
const SATURDAY = 6;

function window(weekday: number, startMinute: number, endMinute: number): LocalWindow {
  return { weekday, startMinute, endMinute };
}

function readable(intervals: NightWindow[]): string[] {
  return intervals.map(
    (interval) => `${interval.duskAt.toISOString()}..${interval.dawnAt.toISOString()}`,
  );
}

describe("a node that has offered no hours", () => {
  it("is available for the whole night", () => {
    expect(openIntervals(NIGHT, [], TBILISI)).toEqual([NIGHT]);
  });

  it("is available for the whole night when every window it has is switched off", () => {
    // The caller filters on `enabled`, so a disabled window arrives here as an
    // absent one. Silence and "switched off" have to mean the same thing, or an
    // owner toggling their last window off would be a different state from an
    // owner who never set one.
    expect(openIntervals(NIGHT, [], TBILISI)).toEqual([NIGHT]);
  });
});

describe("windows narrow the night, and never extend it", () => {
  it("clips an evening window to the hours that are actually dark", () => {
    // 18:00-23:59 Friday. Darkness does not begin until 21:00, so the first
    // three hours of the offer are hours the sky refuses.
    const open = openIntervals(NIGHT, [window(FRIDAY, 1080, 1439)], TBILISI);

    expect(readable(open)).toEqual([
      "2026-09-11T17:00:00.000Z..2026-09-11T19:59:00.000Z",
    ]);
  });

  it("cannot offer an hour outside darkness however wide the window is", () => {
    // The whole of Friday and the whole of Saturday, and it still yields exactly
    // the dark window: availability subtracts, it never adds.
    const open = openIntervals(
      NIGHT,
      [window(FRIDAY, 0, 1440), window(SATURDAY, 0, 1440)],
      TBILISI,
    );

    expect(open).toEqual([NIGHT]);
  });

  it("gives an empty night when the owner has offered only daylight", () => {
    // 09:00-17:00 Friday: a real offer, and none of it is dark. Distinct from
    // having no windows at all, which means no restriction.
    const open = openIntervals(NIGHT, [window(FRIDAY, 540, 1020)], TBILISI);

    expect(open).toEqual([]);
  });
});

describe("a night spans two weekdays", () => {
  it("reads the following day's windows for the hours after local midnight", () => {
    // 00:00-03:00 Saturday is Friday night's late session. A generator that read
    // only the evening's weekday would lose it entirely.
    const open = openIntervals(NIGHT, [window(SATURDAY, 0, 180)], TBILISI);

    expect(readable(open)).toEqual([
      "2026-09-11T20:00:00.000Z..2026-09-11T23:00:00.000Z",
    ]);
  });

  it("keeps an evening and an early-morning window separate when a minute divides them", () => {
    // 23:59 is not midnight. Friday to 1439 and Saturday from 0 leave a
    // one-minute hole, and the merge does not paper over it -- an owner who
    // means one unbroken night writes 1440.
    const open = openIntervals(
      NIGHT,
      [window(FRIDAY, 1080, 1439), window(SATURDAY, 0, 180)],
      TBILISI,
    );

    expect(readable(open)).toEqual([
      "2026-09-11T17:00:00.000Z..2026-09-11T19:59:00.000Z",
      "2026-09-11T20:00:00.000Z..2026-09-11T23:00:00.000Z",
    ]);
  });

  it("joins them into one opening when the evening runs to midnight", () => {
    const open = openIntervals(
      NIGHT,
      [window(FRIDAY, 1080, 1440), window(SATURDAY, 0, 180)],
      TBILISI,
    );

    expect(readable(open)).toEqual([
      "2026-09-11T17:00:00.000Z..2026-09-11T23:00:00.000Z",
    ]);
  });
});

describe("overlapping and adjacent windows", () => {
  it("merges two that touch, so the slot across the join is still offered", () => {
    const open = openIntervals(
      NIGHT,
      [window(FRIDAY, 1260, 1350), window(FRIDAY, 1350, 1440)],
      TBILISI,
    );

    expect(readable(open)).toEqual([
      "2026-09-11T17:00:00.000Z..2026-09-11T20:00:00.000Z",
    ]);
  });

  it("merges two that overlap", () => {
    const open = openIntervals(
      NIGHT,
      [window(FRIDAY, 1260, 1400), window(FRIDAY, 1300, 1440)],
      TBILISI,
    );

    expect(readable(open)).toEqual([
      "2026-09-11T17:00:00.000Z..2026-09-11T20:00:00.000Z",
    ]);
  });

  it("keeps a deliberate gap as a gap", () => {
    // 21:00-22:00 and 23:00-00:00 local. The hour between them is not offered.
    const open = openIntervals(
      NIGHT,
      [window(FRIDAY, 1260, 1320), window(FRIDAY, 1380, 1440)],
      TBILISI,
    );

    expect(readable(open)).toEqual([
      "2026-09-11T17:00:00.000Z..2026-09-11T18:00:00.000Z",
      "2026-09-11T19:00:00.000Z..2026-09-11T20:00:00.000Z",
    ]);
  });

  it("returns intervals in order whatever order the rows arrive in", () => {
    const open = openIntervals(
      NIGHT,
      [window(FRIDAY, 1380, 1440), window(FRIDAY, 1260, 1320)],
      TBILISI,
    );

    expect(open[0].duskAt.getTime()).toBeLessThan(open[1].duskAt.getTime());
  });
});

describe("rows the maths cannot use", () => {
  it("discards a window that ends before it starts rather than guessing", () => {
    // 22:00-02:00 as one row. Which day the 02:00 lands on is not stated, and a
    // guess would offer somebody else's telescope on a night they did not
    // choose. The per-weekday model expresses this as two rows.
    const open = openIntervals(NIGHT, [window(FRIDAY, 1320, 120)], TBILISI);

    // No usable window survives, so this is the no-windows case: unrestricted.
    expect(open).toEqual([NIGHT]);
  });

  it("discards a zero-length window", () => {
    expect(openIntervals(NIGHT, [window(FRIDAY, 1260, 1260)], TBILISI)).toEqual([NIGHT]);
  });

  it("discards a window that runs past the end of the day", () => {
    expect(openIntervals(NIGHT, [window(FRIDAY, 1260, 1500)], TBILISI)).toEqual([NIGHT]);
  });

  it("ignores a usable window belonging to a weekday this night does not touch", () => {
    // Wednesday has nothing to do with Friday night. The night is unrestricted
    // by it, but the row is still usable, so this is the empty-intersection case
    // rather than the no-windows case.
    expect(openIntervals(NIGHT, [window(3, 1080, 1440)], TBILISI)).toEqual([]);
  });
});
