import { describe, expect, it } from "vitest";

import { lostWithin } from "@/refunds/entitlements";

/**
 * The half rule's arithmetic (DV-111). Everything the entitlement decision rests on
 * is how many minutes of a slot were lost and to what, so it is proved here on
 * plain numbers before the integration suite proves the records feed it.
 */
const MINUTE = 60_000;
const START = 0;
const END = 60 * MINUTE;

const weather = (from: number, to: number) => ({ from: from * MINUTE, to: to * MINUTE, cause: "WEATHER" as const });
const fault = (from: number, to: number) => ({
  from: from * MINUTE,
  to: to * MINUTE,
  cause: "OBSERVATORY_FAULT" as const,
});

describe("minutes lost within a slot", () => {
  it("is nothing when nothing was unavailable", () => {
    expect(lostWithin([], START, END)).toEqual({ minutesLost: 0, cause: null });
  });

  it("counts only the part of an outage inside the slot", () => {
    expect(lostWithin([fault(-30, 20)], START, END)).toEqual({
      minutesLost: 20,
      cause: "OBSERVATORY_FAULT",
    });
    expect(lostWithin([weather(50, 120)], START, END)).toEqual({ minutesLost: 10, cause: "WEATHER" });
  });

  it("counts an overlap once, and credits the shared minutes to weather", () => {
    // Weather 0-40, a link outage 20-50: 50 minutes lost, 40 of them weather.
    expect(lostWithin([weather(0, 40), fault(20, 50)], START, END)).toEqual({
      minutesLost: 50,
      cause: "WEATHER",
    });
  });

  it("names the larger cause when the two do not overlap", () => {
    expect(lostWithin([weather(0, 10), fault(20, 50)], START, END)).toEqual({
      minutesLost: 40,
      cause: "OBSERVATORY_FAULT",
    });
  });

  it("ignores an interval entirely outside the slot", () => {
    expect(lostWithin([fault(-60, -1), weather(61, 90)], START, END)).toEqual({
      minutesLost: 0,
      cause: null,
    });
  });
});
