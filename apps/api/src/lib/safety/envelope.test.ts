import { describe, expect, it } from "vitest";

import type { SafetyEnvelopeConfig } from "@darkview/contracts";

import {
  azimuthInSector,
  evaluateNudgeStep,
  evaluatePointing,
  horizonMinimumAltitude,
  isMeasured,
  normaliseAzimuth,
} from "@/lib/safety/envelope";

/**
 * The cloud's half of the two independent safety checks.
 *
 * These mirror the agent's own envelope tests deliberately. The two
 * implementations are separate on purpose, so what has to be verified twice is not
 * the code but the decision: the same condition must produce the same
 * `CommandRejectionReason` on both sides, or an operator reading two audit trails
 * sees a disagreement that is not there.
 */
const SITE = { latitudeDegrees: 41.7151, longitudeDegrees: 44.8271 };

/** Local midnight in Tbilisi: the Sun is far below the horizon. */
const NIGHT = new Date("2026-07-15T20:00:00.000Z");

/** A test fake for MAX_ALT_SAFE, stated at every call site rather than defaulted. */
const MEASURED = 78;
/** Local midday. */
const DAY = new Date("2026-07-15T08:00:00.000Z");

/**
 * Every caller states MAX_ALT_SAFE. There is deliberately no default for it, here
 * or anywhere: `agent/tests/test_no_default_max_altitude.py` fails the build on
 * one, and it is right to -- a fixture default is precisely how an unmeasured
 * value ends up looking measured. The numbers passed below are test fakes; the
 * real one is read off the assembled optical train in DV-034 and does not exist.
 */
function envelope(
  maxAltitude: number | null,
  overrides: Partial<SafetyEnvelopeConfig> = {},
): SafetyEnvelopeConfig {
  return {
    observatoryId: "11111111-1111-4111-8111-111111111111",
    minAltitudeDegrees: 20,
    maxAltitudeDegrees: maxAltitude,
    maxAltitudeMeasuredAt: NIGHT.toISOString(),
    maxAltitudeMeasuredBy: "unit-test fake",
    maxAltitudeMeasurementNote: null,
    horizonMask: [],
    forbiddenAzimuthSectors: [],
    sunExclusionDegrees: 30,
    daylightLockSunAltitudeDegrees: -6,
    nudgeMaxDegrees: 1,
    nudgeRateDegreesPerSecond: 0.25,
    slewTimeoutSeconds: 120,
    heartbeatLossSeconds: 15,
    linkDeadSeconds: 60,
    refocusTemperatureDeltaC: 1.5,
    updatedAt: NIGHT.toISOString(),
    ...overrides,
  };
}

function pointing(overrides: Partial<Parameters<typeof evaluatePointing>[0]> = {}) {
  return evaluatePointing({
    config: envelope(MEASURED),
    site: SITE,
    at: NIGHT,
    altitudeDegrees: 45,
    azimuthDegrees: 180,
    ...overrides,
  });
}

function reasonOf(verdict: ReturnType<typeof evaluatePointing>): string | null {
  return verdict.permitted ? null : verdict.reason;
}

describe("unmeasured is not a configuration state", () => {
  it("treats a null maxAltitudeDegrees as unmeasured", () => {
    expect(isMeasured(envelope(null))).toBe(false);
  });

  it("treats a missing envelope as unmeasured", () => {
    expect(isMeasured(null)).toBe(false);
  });

  it("refuses every pointing while unmeasured", () => {
    expect(reasonOf(pointing({ config: envelope(null) }))).toBe(
      "SAFETY_ENVELOPE_UNMEASURED",
    );
    expect(reasonOf(pointing({ config: null }))).toBe("SAFETY_ENVELOPE_UNMEASURED");
  });

  it("refuses even a pointing that would otherwise be perfectly safe", () => {
    // Nothing about this pointing is wrong except that nobody has measured where
    // the optical train collides with the fork.
    expect(reasonOf(pointing({ config: null, altitudeDegrees: 45 }))).toBe(
      "SAFETY_ENVELOPE_UNMEASURED",
    );
  });
});

describe("the Sun", () => {
  it("refuses a pointing without knowing where the observatory is", () => {
    // Fail closed: an unknown site cannot prove the pointing is clear of the Sun.
    expect(reasonOf(pointing({ site: null }))).toBe("SAFETY_SUN_EXCLUSION");
  });

  it("locks out daylight", () => {
    expect(reasonOf(pointing({ at: DAY, altitudeDegrees: 45, azimuthDegrees: 0 }))).toBe(
      "SAFETY_DAYLIGHT_LOCK",
    );
  });

  it("lets an attended operator through the daylight lock", () => {
    expect(
      pointing({
        at: DAY,
        altitudeDegrees: 45,
        azimuthDegrees: 0,
        operatorOverride: true,
      }).permitted,
    ).toBe(true);
  });

  it("never lets anyone through the Sun exclusion", () => {
    // Due south at midday in July from Tbilisi is close to the Sun.
    const atTheSun = { at: DAY, altitudeDegrees: 70, azimuthDegrees: 180 };
    expect(reasonOf(pointing(atTheSun))).toBe("SAFETY_SUN_EXCLUSION");
    expect(reasonOf(pointing({ ...atTheSun, operatorOverride: true }))).toBe(
      "SAFETY_SUN_EXCLUSION",
    );
  });
});

describe("altitude limits", () => {
  it("refuses below the minimum", () => {
    expect(reasonOf(pointing({ altitudeDegrees: 19.9 }))).toBe(
      "SAFETY_BELOW_MIN_ALTITUDE",
    );
  });

  it("refuses above the measured maximum", () => {
    expect(reasonOf(pointing({ altitudeDegrees: 78.1 }))).toBe(
      "SAFETY_ABOVE_MAX_ALTITUDE",
    );
  });

  it("permits the boundaries themselves", () => {
    expect(pointing({ altitudeDegrees: 20 }).permitted).toBe(true);
    expect(pointing({ altitudeDegrees: 78 }).permitted).toBe(true);
  });
});

describe("the horizon mask", () => {
  it("imposes nothing when the site has not been surveyed", () => {
    expect(horizonMinimumAltitude(123, [])).toBeNull();
  });

  it("interpolates between surveyed bearings", () => {
    const mask = [
      { azimuthDegrees: 0, minAltitudeDegrees: 10 },
      { azimuthDegrees: 180, minAltitudeDegrees: 30 },
    ];
    expect(horizonMinimumAltitude(90, mask)).toBeCloseTo(20, 6);
  });

  it("interpolates across north rather than falling off the end", () => {
    const mask = [
      { azimuthDegrees: 0, minAltitudeDegrees: 10 },
      { azimuthDegrees: 180, minAltitudeDegrees: 30 },
    ];
    // Halfway from 180 back round to 360/0.
    expect(horizonMinimumAltitude(270, mask)).toBeCloseTo(20, 6);
  });

  it("refuses a pointing under the surveyed horizon", () => {
    const verdict = pointing({
      config: envelope(MEASURED, {
        horizonMask: [{ azimuthDegrees: 180, minAltitudeDegrees: 35 }],
      }),
      altitudeDegrees: 30,
      azimuthDegrees: 180,
    });
    expect(reasonOf(verdict)).toBe("SAFETY_HORIZON_MASK");
  });
});

describe("cable-wrap sectors", () => {
  it("is inclusive at the start and exclusive at the end", () => {
    expect(azimuthInSector(90, 90, 100)).toBe(true);
    expect(azimuthInSector(100, 90, 100)).toBe(false);
  });

  it("handles a sector that wraps through north", () => {
    expect(azimuthInSector(355, 350, 10)).toBe(true);
    expect(azimuthInSector(5, 350, 10)).toBe(true);
    expect(azimuthInSector(180, 350, 10)).toBe(false);
  });

  it("normalises a bearing outside 0..360", () => {
    expect(normaliseAzimuth(-10)).toBeCloseTo(350, 9);
    expect(normaliseAzimuth(370)).toBeCloseTo(10, 9);
  });

  it("refuses a pointing inside a forbidden sector", () => {
    const verdict = pointing({
      config: envelope(MEASURED, {
        forbiddenAzimuthSectors: [{ fromDegrees: 170, toDegrees: 190 }],
      }),
      azimuthDegrees: 180,
    });
    expect(reasonOf(verdict)).toBe("SAFETY_FORBIDDEN_AZIMUTH");
  });
});

describe("rule order", () => {
  /**
   * When several rules are broken at once the reason returned is the most
   * fundamental one, matching the agent. A pointing that is both unmeasured and
   * at the Sun is refused as unmeasured on both sides, so the two audit trails
   * describe it identically.
   */
  it("reports unmeasured ahead of everything else", () => {
    const verdict = evaluatePointing({
      config: envelope(null),
      site: SITE,
      at: DAY,
      altitudeDegrees: 89,
      azimuthDegrees: 180,
    });
    expect(reasonOf(verdict)).toBe("SAFETY_ENVELOPE_UNMEASURED");
  });

  it("reports the Sun ahead of the altitude limits", () => {
    const verdict = evaluatePointing({
      config: envelope(MEASURED),
      site: SITE,
      at: DAY,
      altitudeDegrees: 85, // also above the maximum
      azimuthDegrees: 180,
    });
    expect(reasonOf(verdict)).toBe("SAFETY_SUN_EXCLUSION");
  });
});

describe("nudge steps", () => {
  it("refuses while unmeasured", () => {
    const verdict = evaluateNudgeStep(envelope(null), 0.05);
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.reason).toBe("SAFETY_ENVELOPE_UNMEASURED");
  });

  it("refuses a step beyond the permitted rate", () => {
    const verdict = evaluateNudgeStep(envelope(MEASURED), 0.5);
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.reason).toBe("SAFETY_SLEW_RATE");
  });

  it("refuses a negative step, because direction is carried separately", () => {
    const verdict = evaluateNudgeStep(envelope(MEASURED), -0.05);
    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.reason).toBe("SAFETY_NUDGE_LIMIT_EXCEEDED");
  });

  it("permits a step inside the envelope", () => {
    expect(evaluateNudgeStep(envelope(MEASURED), 0.05).permitted).toBe(true);
  });

  /**
   * The cloud bounds the step; the agent bounds the running total. The cloud has
   * no honest copy of where the mount actually is, and a second number that drifts
   * from the real one would eventually contradict it.
   */
  it("does not pretend to know the cumulative offset", () => {
    expect(evaluateNudgeStep(envelope(MEASURED), 0.25).permitted).toBe(true);
    expect(evaluateNudgeStep(envelope(MEASURED), 0.25).permitted).toBe(true);
  });
});
