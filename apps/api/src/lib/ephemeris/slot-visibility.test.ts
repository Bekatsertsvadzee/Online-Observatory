import { describe, expect, it } from "vitest";

import type { SafetyEnvelopeConfig } from "@darkview/contracts";
import { zSlotVisibility } from "@darkview/contracts/zod";
import { PHASE1_TARGETS } from "@darkview/db/phase1-catalogue";

import {
  evaluateSlotVisibility,
  slotSampleInstants,
} from "@/lib/ephemeris/slot-visibility";
import type { VisibilityInput } from "@/lib/ephemeris/visibility";

/**
 * #151 at fixed instants, at the two sites the development seed runs: Tbilisi and
 * the night-side demo on Mauna Kea (`packages/db/prisma/development-seed.ts`).
 * Nothing reads the wall clock.
 *
 * Positions on the night of 2026-12-15, from the ephemeris engine itself:
 *   Tbilisi 16:00Z   Saturn 49 deg, Jupiter -24 deg (not risen)
 *   Tbilisi 23:00Z   Saturn -11 deg (set), Jupiter 48 deg
 *   Tbilisi 19:20Z   Saturn 28.7 deg, sinking through 25 deg at about 19:41Z
 *   Mauna Kea 08:00Z Saturn 46 deg, Jupiter -4 deg (not yet risen)
 */
const TBILISI = { latitudeDegrees: 41.7151, longitudeDegrees: 44.8271 };
const MAUNA_KEA = { latitudeDegrees: 19.8207, longitudeDegrees: -155.4681 };

/**
 * FABRICATED for tests, like the clearance in `visibility.test.ts`. MAX_ALT_SAFE is
 * measured from the optical train and no real value exists yet.
 */
const FABRICATED_CLEARANCE_DEGREES = 65;

/** Under Saturn's 49 degrees at Tbilisi dusk. Also fabricated. */
const DELIBERATELY_LOW_CEILING_DEGREES = 40;

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
  return { ...found, enabled: true } as unknown as VisibilityInput["target"];
}

function judge(
  slug: string,
  startAt: string,
  options: {
    site?: typeof TBILISI;
    envelope?: SafetyEnvelopeConfig | null;
    durationMinutes?: number;
    online?: boolean;
  } = {},
) {
  return evaluateSlotVisibility({
    target: target(slug),
    site: options.site ?? TBILISI,
    envelope: options.envelope === undefined ? envelope() : options.envelope,
    observatory: { online: options.online ?? true, weatherHold: false },
    startAt: new Date(startAt),
    durationMinutes: options.durationMinutes ?? 30,
  });
}

describe("which planets a slot can deliver, at the seeded sites", () => {
  it("delivers Saturn and not Jupiter early on a Tbilisi December night", () => {
    const saturn = judge("saturn", "2026-12-15T16:00:00Z");
    const jupiter = judge("jupiter", "2026-12-15T16:00:00Z");

    expect(saturn).toMatchObject({ observable: true, blockReasons: [] });
    expect(jupiter.observable).toBe(false);
    expect(jupiter.blockReasons).toEqual(["BELOW_HORIZON"]);
  });

  it("delivers Jupiter and not Saturn late the same night, after Saturn has set", () => {
    const saturn = judge("saturn", "2026-12-15T23:00:00Z");
    const jupiter = judge("jupiter", "2026-12-15T23:00:00Z");

    expect(saturn.observable).toBe(false);
    expect(saturn.blockReasons).toContain("BELOW_HORIZON");
    expect(jupiter.observable).toBe(true);
  });

  it("judges Mauna Kea by its own sky: Saturn up, Jupiter not yet risen", () => {
    const saturn = judge("saturn", "2026-12-16T08:00:00Z", { site: MAUNA_KEA });
    const jupiter = judge("jupiter", "2026-12-16T08:00:00Z", { site: MAUNA_KEA });

    expect(saturn.observable).toBe(true);
    expect(jupiter.observable).toBe(false);
    expect(jupiter.blockReasons).toContain("BELOW_HORIZON");

    // The same instant at Tbilisi is noon.
    expect(judge("saturn", "2026-12-16T08:00:00Z").blockReasons).toContain("SUN_TOO_HIGH");
  });
});

describe("across the whole slot, not only its start", () => {
  it("refuses a target that sinks under its minimum altitude before the slot ends", () => {
    const result = judge("saturn", "2026-12-15T19:20:00Z");

    // Up when the slot opens -- which is all `GET /targets/tonight` could say.
    expect(result.atStart.observable).toBe(true);
    expect(result.atStart.evaluatedAt).toBe("2026-12-15T19:20:00.000Z");

    expect(result.observable).toBe(false);
    expect(result.blockReasons).toEqual(["BELOW_MIN_ALTITUDE"]);
  });

  it("samples the start, every five minutes, and the end", () => {
    const instants = slotSampleInstants(new Date("2026-12-15T19:20:00Z"), 12);
    expect(instants.map((at) => at.toISOString())).toEqual([
      "2026-12-15T19:20:00.000Z",
      "2026-12-15T19:25:00.000Z",
      "2026-12-15T19:30:00.000Z",
      "2026-12-15T19:32:00.000Z",
    ]);
  });
});

describe("the observatory's safety envelope, as the slew is judged", () => {
  it("refuses a target behind the surveyed horizon", () => {
    // Saturn is due south at 49 degrees; a wall to the south at 60 hides it.
    const walled = envelope({
      horizonMask: [
        { azimuthDegrees: 90, minAltitudeDegrees: 10 },
        { azimuthDegrees: 150, minAltitudeDegrees: 60 },
        { azimuthDegrees: 210, minAltitudeDegrees: 60 },
        { azimuthDegrees: 270, minAltitudeDegrees: 10 },
      ],
    });

    const result = judge("saturn", "2026-12-15T16:00:00Z", { envelope: walled });

    expect(result.atStart.observable).toBe(true);
    expect(result).toMatchObject({ observable: false, blockReasons: ["BEHIND_HORIZON_MASK"] });
  });

  it("refuses a target inside a forbidden azimuth sector", () => {
    const result = judge("saturn", "2026-12-15T16:00:00Z", {
      envelope: envelope({ forbiddenAzimuthSectors: [{ fromDegrees: 170, toDegrees: 200 }] }),
    });

    expect(result.blockReasons).toEqual(["IN_FORBIDDEN_AZIMUTH"]);
  });

  it("applies the envelope's minimum altitude when it is stricter than the target's", () => {
    const result = judge("saturn", "2026-12-15T16:00:00Z", {
      envelope: envelope({ minAltitudeDegrees: 55 }),
    });

    expect(result.blockReasons).toEqual(["BELOW_MIN_ALTITUDE"]);
  });

  it("refuses a target above the measured maximum altitude", () => {
    const result = judge("saturn", "2026-12-15T16:00:00Z", {
      envelope: envelope({ maxAltitudeDegrees: DELIBERATELY_LOW_CEILING_DEGREES }),
    });

    expect(result.blockReasons).toContain("ABOVE_MAX_ALTITUDE");
  });
});

describe("what a slot does not decide", () => {
  it("leaves observatory-wide conditions to GET /slots", () => {
    const result = judge("saturn", "2026-12-15T16:00:00Z", { envelope: null, online: false });

    // The full instant is honest about both...
    expect(result.atStart.blockReasons).toEqual(
      expect.arrayContaining(["SAFETY_ENVELOPE_UNMEASURED", "OBSERVATORY_OFFLINE"]),
    );
    // ...but neither is a fact about this target in this slot.
    expect(result).toMatchObject({ observable: true, blockReasons: [] });
  });

  it("does not refuse the Moon for being wider than the field", () => {
    // Moon at 31 degrees over Tbilisi at 16:00Z.
    const result = judge("moon-terminator", "2026-12-15T16:00:00Z");

    expect(result.atStart.blockReasons).toContain("DOES_NOT_FIT_FIELD");
    expect(result.observable).toBe(true);
  });

  it("still refuses a disabled target", () => {
    const result = evaluateSlotVisibility({
      target: { ...target("saturn"), enabled: false },
      site: TBILISI,
      envelope: envelope(),
      observatory: { online: true, weatherHold: false },
      startAt: new Date("2026-12-15T16:00:00Z"),
      durationMinutes: 30,
    });

    expect(result.blockReasons).toEqual(["TARGET_DISABLED"]);
  });

  it("produces a body the contract's own schema accepts", () => {
    expect(zSlotVisibility.safeParse(judge("saturn", "2026-12-15T19:20:00Z")).success).toBe(true);
  });
});
