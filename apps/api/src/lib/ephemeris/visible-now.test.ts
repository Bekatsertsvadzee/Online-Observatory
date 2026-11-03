import { describe, expect, it } from "vitest";

import type { SafetyEnvelopeConfig } from "@darkview/contracts";
import { PHASE1_TARGETS } from "@darkview/db/phase1-catalogue";

import { evaluateVisibleNow } from "@/lib/ephemeris/visible-now";
import type { VisibilityInput } from "@/lib/ephemeris/visibility";

/**
 * ADR-079's visible-now list at fixed instants, with the positions
 * `slot-visibility.test.ts` already records from the ephemeris engine:
 *   Tbilisi 16:00Z  Saturn 49 deg, Jupiter -24 deg (not risen)
 *   Tbilisi 19:20Z  Saturn 28.7 deg, sinking through 25 deg at about 19:41Z
 * Nothing reads the wall clock.
 */
const TBILISI = { latitudeDegrees: 41.7151, longitudeDegrees: 44.8271 };

/** FABRICATED for tests. MAX_ALT_SAFE is measured and no real value exists yet. */
const FABRICATED_CLEARANCE_DEGREES = 65;

function envelope(overrides: Partial<SafetyEnvelopeConfig> = {}): SafetyEnvelopeConfig {
  return {
    observatoryId: "00000000-0000-4000-8000-000000000001",
    minAltitudeDegrees: 15,
    maxAltitudeDegrees: FABRICATED_CLEARANCE_DEGREES,
    maxAltitudeMeasuredAt: null,
    maxAltitudeMeasuredBy: "test fixture",
    maxAltitudeMeasurementNote: null,
    horizonMask: [],
    forbiddenAzimuthSectors: [],
    sunExclusionDegrees: 30,
    daylightLockSunAltitudeDegrees: -6,
    nudgeMaxDegrees: 0.5,
    nudgeRateDegreesPerSecond: 0.5,
    slewTimeoutSeconds: 120,
    heartbeatLossSeconds: 15,
    linkDeadSeconds: 60,
    refocusTemperatureDeltaC: 2,
    updatedAt: "2026-12-01T00:00:00.000Z",
    ...overrides,
  };
}

function target(slug: string) {
  const found = PHASE1_TARGETS.find((row) => row.slug === slug);
  if (!found) throw new Error(`${slug} not in the catalogue`);
  return { ...found, id: `id-${slug}`, enabled: true } as unknown as VisibilityInput["target"] & {
    id: string;
  };
}

function visibleNow(
  slugs: string[],
  now: string,
  sessionEndsAt: string,
  options: { envelope?: SafetyEnvelopeConfig | null; currentTargetId?: string | null } = {},
) {
  return evaluateVisibleNow({
    targets: slugs.map(target),
    site: TBILISI,
    envelope: options.envelope === undefined ? envelope() : options.envelope,
    observatory: { online: true, weatherHold: false },
    now: new Date(now),
    sessionEndsAt: new Date(sessionEndsAt),
    currentTargetId: options.currentTargetId ?? null,
  });
}

describe("what a live session may switch to now (ADR-079)", () => {
  it("lists what is up across the next ten minutes and leaves out what is not", () => {
    const result = visibleNow(["saturn", "jupiter"], "2026-12-15T16:00:00Z", "2026-12-15T17:00:00Z");

    expect(result.items.map((item) => item.target.slug)).toEqual(["saturn"]);
    expect(result.windowEndsAt.toISOString()).toBe("2026-12-15T16:10:00.000Z");
    expect(result.blocked.get("id-jupiter")).toContain("BELOW_HORIZON");
  });

  it("clamps the window to the session's end", () => {
    const result = visibleNow(["saturn"], "2026-12-15T16:00:00Z", "2026-12-15T16:04:00Z");

    expect(result.windowEndsAt.toISOString()).toBe("2026-12-15T16:04:00.000Z");
    expect(result.items[0]?.observableUntil.toISOString()).toBe("2026-12-15T16:04:00.000Z");
  });

  it("leaves out an object that sets inside the dwell window", () => {
    // Saturn is above 25 degrees at 19:35 but sinks through it at about 19:41.
    const result = visibleNow(["saturn"], "2026-12-15T19:35:00Z", "2026-12-15T20:30:00Z", {
      currentTargetId: "id-saturn",
    });

    expect(result.items).toEqual([]);
    expect(result.blocked.get("id-saturn")).toEqual(["BELOW_MIN_ALTITUDE"]);
  });

  it("says until when a listed object stays up, by five-minute steps", () => {
    const result = visibleNow(["saturn"], "2026-12-15T19:20:00Z", "2026-12-15T20:20:00Z");

    // 19:40 already fails: the airless altitude the slew is judged on is under the
    // refracted one, so Saturn is below its limit for pointing before 19:41.
    expect(result.items[0]?.observableUntil.toISOString()).toBe("2026-12-15T19:35:00.000Z");
  });

  it("flags the object the session is on", () => {
    const result = visibleNow(["saturn"], "2026-12-15T16:00:00Z", "2026-12-15T17:00:00Z", {
      currentTargetId: "id-saturn",
    });

    expect(result.items[0]?.current).toBe(true);
  });

  it("offers nothing while MAX_ALT_SAFE is unmeasured", () => {
    const result = visibleNow(["saturn"], "2026-12-15T16:00:00Z", "2026-12-15T17:00:00Z", {
      envelope: envelope({ maxAltitudeDegrees: null }),
    });

    expect(result.items).toEqual([]);
    expect(result.blocked.get("id-saturn")).toEqual(["SAFETY_ENVELOPE_UNMEASURED"]);
  });

  it("ranks highest at the window's middle first, as Best in the sky does", () => {
    const slugs = PHASE1_TARGETS.map((row) => row.slug);
    const result = visibleNow(slugs, "2026-12-15T16:00:00Z", "2026-12-15T17:00:00Z");
    const altitudes = result.items.map((item) => item.visibility.atStart.horizontal.altitudeDegrees);

    expect(result.items.length).toBeGreaterThan(1);
    // Ranked at mid-window, so compare loosely at the start: the first is no lower
    // than any later one by more than the ten minutes' motion allows.
    expect(Math.max(...altitudes) - (altitudes[0] ?? 0)).toBeLessThan(3);
  });
});
