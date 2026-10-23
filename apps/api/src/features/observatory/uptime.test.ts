import { describe, expect, it, vi } from "vitest";

import { zObservatoryUptime } from "@darkview/contracts/zod";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDatabase: () => null }));

const { computeUptime } = await import("@/features/observatory/uptime");

const TZ = "Asia/Tbilisi";
const ID = "00000000-0000-4000-8000-000000000001";
/** 12:00 in Tbilisi on 16 December: today is half over. */
const NOW = new Date("2026-12-16T08:00:00.000Z");
const DAY = 86_400;
const at = (iso: string) => new Date(iso);

describe("computeUptime", () => {
  it("cuts thirty local days, the last of them today so far, and fits the contract", () => {
    const uptime = computeUptime({
      observatoryId: ID,
      timeZone: TZ,
      now: NOW,
      before: null,
      events: [],
    });

    expect(zObservatoryUptime.parse(uptime)).toEqual(uptime);
    expect(uptime.days).toHaveLength(30);
    expect(uptime.days[0].date).toBe("2026-11-17");
    expect(uptime.days[29].date).toBe("2026-12-16");
    // Local midnight, four hours ahead of UTC.
    expect(uptime.from).toBe("2026-11-16T20:00:00.000Z");
  });

  it("reports nothing it never measured: no event ever is null, never 100", () => {
    const uptime = computeUptime({
      observatoryId: ID,
      timeZone: TZ,
      now: NOW,
      before: null,
      events: [],
    });

    expect(uptime.uptimePercent).toBeNull();
    expect(
      uptime.days.every((day) => day.measuredSeconds === 0 && day.uptimePercent === null),
    ).toBe(true);
  });

  it("counts a link that came up before the window as up for all of it", () => {
    const uptime = computeUptime({
      observatoryId: ID,
      timeZone: TZ,
      now: NOW,
      before: { at: at("2026-10-01T00:00:00.000Z"), up: true },
      events: [],
    });

    expect(uptime.uptimePercent).toBe(100);
    expect(uptime.days[0]).toMatchObject({
      measuredSeconds: DAY,
      onlineSeconds: DAY,
      uptimePercent: 100,
    });
    expect(uptime.days[29]).toMatchObject({
      measuredSeconds: DAY / 2,
      onlineSeconds: DAY / 2,
    });
    expect(uptime.incidents).toEqual([]);
  });

  it("splits an outage across local midnight and lists it as one incident", () => {
    const uptime = computeUptime({
      observatoryId: ID,
      timeZone: TZ,
      now: NOW,
      before: { at: at("2026-10-01T00:00:00.000Z"), up: true },
      events: [
        // 23:00 on the 14th to 01:00 on the 15th, Tbilisi time.
        { at: at("2026-12-14T19:00:00.000Z"), up: false },
        { at: at("2026-12-14T21:00:00.000Z"), up: true },
      ],
    });

    const day14 = uptime.days.find((day) => day.date === "2026-12-14");
    const day15 = uptime.days.find((day) => day.date === "2026-12-15");
    expect(day14).toMatchObject({ measuredSeconds: DAY, onlineSeconds: DAY - 3600 });
    expect(day15).toMatchObject({ measuredSeconds: DAY, onlineSeconds: DAY - 3600 });
    expect(day14?.uptimePercent).toBe(95.83);
    expect(uptime.incidents).toEqual([
      { lostAt: "2026-12-14T19:00:00.000Z", restoredAt: "2026-12-14T21:00:00.000Z" },
    ]);
  });

  it("starts measuring at the first event when the link had none before the window", () => {
    const uptime = computeUptime({
      observatoryId: ID,
      timeZone: TZ,
      now: NOW,
      before: null,
      events: [{ at: at("2026-12-15T20:00:00.000Z"), up: true }],
    });

    expect(uptime.days[28]).toMatchObject({ measuredSeconds: 0, uptimePercent: null });
    expect(uptime.days[29]).toMatchObject({
      measuredSeconds: DAY / 2,
      onlineSeconds: DAY / 2,
    });
    expect(uptime.uptimePercent).toBe(100);
  });

  it("leaves an incident open while the link is still down, newest first", () => {
    const uptime = computeUptime({
      observatoryId: ID,
      timeZone: TZ,
      now: NOW,
      before: { at: at("2026-10-01T00:00:00.000Z"), up: true },
      events: [
        { at: at("2026-12-10T10:00:00.000Z"), up: false },
        { at: at("2026-12-10T10:05:00.000Z"), up: true },
        { at: at("2026-12-16T06:00:00.000Z"), up: false },
      ],
    });

    expect(uptime.incidents).toEqual([
      { lostAt: "2026-12-16T06:00:00.000Z", restoredAt: null },
      { lostAt: "2026-12-10T10:00:00.000Z", restoredAt: "2026-12-10T10:05:00.000Z" },
    ]);
    expect(uptime.days[29]).toMatchObject({
      measuredSeconds: DAY / 2,
      onlineSeconds: DAY / 2 - 7200,
    });
  });

  it("treats a repeated link-up as still up, as an idle demo's wake looks", () => {
    const uptime = computeUptime({
      observatoryId: ID,
      timeZone: TZ,
      now: NOW,
      before: { at: at("2026-10-01T00:00:00.000Z"), up: true },
      events: [{ at: at("2026-12-12T10:00:00.000Z"), up: true }],
    });

    expect(uptime.uptimePercent).toBe(100);
    expect(uptime.incidents).toEqual([]);
  });
});
