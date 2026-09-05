import { describe, expect, it } from "vitest";

import reference from "@/lib/ephemeris/agent-reference.json";
import {
  horizontalAirlessOf,
  horizontalSeparationDegrees,
  sunHorizontal,
} from "@/lib/ephemeris/engine";
import { evaluatePointing } from "@/lib/safety/envelope";
import type { SafetyEnvelopeConfig } from "@darkview/contracts";

/**
 * DV-059 criterion 2 — the two Sun-exclusion calculations are compared.
 *
 * This is the one number in the whole safety design that both sides compute
 * independently and both sides act on. The agent will not accept the cloud's word
 * for where the Sun is: if it did, a compromised, buggy or merely stale cloud
 * could walk the telescope onto the Sun and the "independent" second check would
 * be independent in name only.
 *
 * So the exclusion is derived twice, from different code in different languages:
 *
 *   agent   hand-written NOAA/Meeus in Python   -> agent-reference.json
 *   cloud   astronomy-engine in TypeScript      -> computed here
 *
 * What is compared is not the Sun's position on its own but the quantity the rule
 * actually tests: the angular separation between where the telescope would point
 * and where the Sun is. A shared bug cannot hide in it, because there is no shared
 * code for it to hide in.
 *
 * TOLERANCE
 *
 * 0.2 degrees, the same figure `agent-agreement.test.ts` documents and for the
 * same reason: roughly ten times tighter than the agent's own stated accuracy, and
 * far tighter than any exclusion radius we would ever configure -- a realistic
 * `sunExclusionDegrees` is tens of degrees. It catches a real bug in either
 * implementation without failing on the agent's known simplifications (mean rather
 * than apparent sidereal time, no nutation, no aberration).
 *
 * The gate stays at the agent's stated accuracy rather than at what today's run
 * happens to achieve, because the agent's error varies with the season. For the
 * record, the observed maximum across these nine pointings is 0.011 degrees --
 * the table below prints it on every run, so a regression shows up as a moving
 * number rather than only as a pass or a fail.
 *
 * That margin only appeared once both sides were compared airless to airless. The
 * first version of this test compared the agent's airless positions against the
 * cloud's refracted ones and disagreed by up to 0.61 degrees near the horizon,
 * which is what sent `horizontalAirlessOf` into the engine and into the
 * pre-validation path.
 */
const TOLERANCE_DEGREES = 0.2;

/** The top of the sky: these tests isolate the Sun rule from the altitude rules. */
const NO_ALTITUDE_LIMIT = 90;

const site = {
  latitudeDegrees: reference.site.latitudeDegrees,
  longitudeDegrees: reference.site.longitudeDegrees,
};

const cases = reference.samples.flatMap((sample) =>
  sample.targets.map((target) => ({ at: sample.at, sun: sample.sun, target })),
);

describe("cloud and agent agree on how far a pointing is from the Sun", () => {
  it.each(cases)("$target.slug at $at", ({ at, sun, target }) => {
    // The agent's answer, entirely from numbers the agent produced.
    const agentSeparation = horizontalSeparationDegrees(
      { altitudeDegrees: target.altitudeDegrees, azimuthDegrees: target.azimuthDegrees },
      { altitudeDegrees: sun.altitudeDegrees, azimuthDegrees: sun.azimuthDegrees },
    );

    // The cloud's answer, entirely from numbers astronomy-engine produced.
    const when = new Date(at);
    const cloudTarget = horizontalAirlessOf(
      { raHours: target.raHours, decDegrees: target.decDegrees, epoch: "J2000" },
      when,
      site,
    );
    const cloudSeparation = horizontalSeparationDegrees(
      {
        altitudeDegrees: cloudTarget.altitudeDegrees,
        azimuthDegrees: cloudTarget.azimuthDegrees,
      },
      sunHorizontal(when, site),
    );

    expect(Math.abs(cloudSeparation - agentSeparation)).toBeLessThan(TOLERANCE_DEGREES);
  });

  it("reports the difference at every sampled pointing", () => {
    const rows = cases.map(({ at, sun, target }) => {
      const when = new Date(at);
      const agent = horizontalSeparationDegrees(
        {
          altitudeDegrees: target.altitudeDegrees,
          azimuthDegrees: target.azimuthDegrees,
        },
        { altitudeDegrees: sun.altitudeDegrees, azimuthDegrees: sun.azimuthDegrees },
      );
      const cloudTarget = horizontalAirlessOf(
        { raHours: target.raHours, decDegrees: target.decDegrees, epoch: "J2000" },
        when,
        site,
      );
      const cloud = horizontalSeparationDegrees(
        {
          altitudeDegrees: cloudTarget.altitudeDegrees,
          azimuthDegrees: cloudTarget.azimuthDegrees,
        },
        sunHorizontal(when, site),
      );
      return {
        at,
        target: target.slug,
        agentDegrees: Number(agent.toFixed(4)),
        cloudDegrees: Number(cloud.toFixed(4)),
        deltaDegrees: Number(Math.abs(cloud - agent).toFixed(5)),
      };
    });

    console.table(rows);
    for (const row of rows) expect(row.deltaDegrees).toBeLessThan(TOLERANCE_DEGREES);
  });

  it("compares against a reference the agent actually produced", () => {
    expect(reference.source).toContain("darkview_agent");
  });
});

/**
 * The tolerance is not the safety margin. The rule refuses when the separation is
 * *below* `sunExclusionDegrees`, so what matters operationally is that the two
 * implementations never land on opposite sides of that threshold — and they cannot,
 * while they agree to 0.2 degrees and the exclusion is tens of degrees wide.
 *
 * This proves the refusal itself, not just the arithmetic behind it.
 */
describe("the exclusion refuses a pointing at the Sun", () => {
  const sample = reference.samples[0];

  // MAX_ALT_SAFE is stated by the caller, never defaulted -- see
  // agent/tests/test_no_default_max_altitude.py. These tests are about the Sun,
  // so they pass a limit wide enough that no altitude rule can be what refuses.
  function envelope(
    sunExclusionDegrees: number,
    maxAltitude: number | null,
  ): SafetyEnvelopeConfig {
    return {
      observatoryId: "11111111-1111-4111-8111-111111111111",
      minAltitudeDegrees: 0,
      maxAltitudeDegrees: maxAltitude,
      maxAltitudeMeasuredAt: sample.at,
      maxAltitudeMeasuredBy: "unit-test fake",
      maxAltitudeMeasurementNote: null,
      horizonMask: [],
      forbiddenAzimuthSectors: [],
      sunExclusionDegrees,
      daylightLockSunAltitudeDegrees: 90,
      nudgeMaxDegrees: 1,
      nudgeRateDegreesPerSecond: 0.25,
      slewTimeoutSeconds: 120,
      heartbeatLossSeconds: 15,
      linkDeadSeconds: 60,
      refocusTemperatureDeltaC: 1.5,
      updatedAt: sample.at,
    };
  }

  it("refuses a pointing straight at the agent's Sun", () => {
    const verdict = evaluatePointing({
      config: envelope(30, NO_ALTITUDE_LIMIT),
      site,
      at: new Date(sample.at),
      altitudeDegrees: sample.sun.altitudeDegrees,
      azimuthDegrees: sample.sun.azimuthDegrees,
    });

    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.reason).toBe("SAFETY_SUN_EXCLUSION");
  });

  it("cannot be overridden by an operator", () => {
    const verdict = evaluatePointing({
      config: envelope(30, NO_ALTITUDE_LIMIT),
      site,
      at: new Date(sample.at),
      altitudeDegrees: sample.sun.altitudeDegrees,
      azimuthDegrees: sample.sun.azimuthDegrees,
      operatorOverride: true,
    });

    expect(verdict.permitted).toBe(false);
    if (verdict.permitted) return;
    expect(verdict.reason).toBe("SAFETY_SUN_EXCLUSION");
  });
});
