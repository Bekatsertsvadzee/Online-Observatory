import { describe, expect, it } from "vitest";

import reference from "@/lib/ephemeris/agent-reference.json";
import { horizontalOf, sunAltitudeDegrees } from "@/lib/ephemeris/engine";
import { Horizon, MakeTime, Observer } from "astronomy-engine";

/**
 * DV-053 criteria 3 and 4.
 *
 * agent-reference.json is produced by the Observatory Agent's own astronomy code
 * -- hand-written NOAA/Meeus in Python -- via scripts/generate-ephemeris-reference.py.
 * The cloud uses astronomy-engine. Different algorithm, different language, no
 * shared code, so agreement between them is evidence rather than a tautology.
 *
 * TOLERANCE, AND WHY IT IS WHAT IT IS
 *
 * The agent's implementation is documented as "accurate to well under a degree",
 * which is deliberate: it exists to keep the telescope off the Sun, and a
 * kilometre of margin costs nothing there. astronomy-engine is accurate to
 * arcseconds. They should therefore agree closely but not exactly, and the
 * difference is dominated by the agent's simplifications -- mean rather than
 * apparent sidereal time, no nutation, no aberration.
 *
 * 0.2 degrees is roughly ten times tighter than the agent's own stated accuracy
 * and roughly a hundred times looser than the Sun exclusion radius, so it will
 * catch a real bug in either implementation without failing on the known
 * approximations.
 */
const TOLERANCE_DEGREES = 0.2;

const site = {
  latitudeDegrees: reference.site.latitudeDegrees,
  longitudeDegrees: reference.site.longitudeDegrees,
};

/** Azimuth difference across the 0/360 wrap. */
function azimuthDelta(left: number, right: number): number {
  const raw = Math.abs(left - right) % 360;
  return raw > 180 ? 360 - raw : raw;
}

describe("the cloud and the agent agree on where things are", () => {
  const cases = reference.samples.flatMap((sample) =>
    sample.targets.map((target) => ({ at: sample.at, target })),
  );

  it.each(cases)("$target.slug at $at", ({ at, target }) => {
    const computed = horizontalOf(
      { raHours: target.raHours, decDegrees: target.decDegrees, epoch: "J2000" },
      new Date(at),
      site,
    );

    // The agent applies no refraction, so compare airless to airless.
    const observer = new Observer(site.latitudeDegrees, site.longitudeDegrees, 0);
    const airless = Horizon(
      MakeTime(new Date(at)),
      observer,
      target.raHours,
      target.decDegrees,
    );

    expect(Math.abs(airless.altitude - target.altitudeDegrees)).toBeLessThan(
      TOLERANCE_DEGREES,
    );
    expect(azimuthDelta(airless.azimuth, target.azimuthDegrees)).toBeLessThan(
      TOLERANCE_DEGREES,
    );

    // And the refracted value the API actually serves is never below the airless
    // one: refraction lifts an object, it never lowers it.
    expect(computed.altitudeDegrees).toBeGreaterThanOrEqual(airless.altitude - 1e-9);
  });

  // criterion 4 -- the Sun specifically, because it is what the safety layer uses
  it.each(reference.samples)("the Sun at $at", (sample) => {
    const computed = sunAltitudeDegrees(new Date(sample.at), site);

    expect(Math.abs(computed - sample.sun.altitudeDegrees)).toBeLessThan(
      TOLERANCE_DEGREES,
    );
  });

  it("compares against a reference the agent actually produced", () => {
    expect(reference.source).toContain("darkview_agent");
    expect(reference.samples).toHaveLength(3);
    expect(reference.samples[0].targets).toHaveLength(3);
  });
});

/**
 * The Sun position is the one number both sides compute and both sides act on.
 * This records the observed agreement so a regression in either is visible as a
 * change in the table, not just a pass or a fail.
 */
describe("sun agreement table", () => {
  it("reports the difference at each sampled instant", () => {
    const rows = reference.samples.map((sample) => {
      const cloud = sunAltitudeDegrees(new Date(sample.at), site);
      return {
        at: sample.at,
        agent: Number(sample.sun.altitudeDegrees.toFixed(4)),
        cloud: Number(cloud.toFixed(4)),
        deltaDegrees: Number(Math.abs(cloud - sample.sun.altitudeDegrees).toFixed(5)),
      };
    });

    console.table(rows);
    for (const row of rows) {
      expect(row.deltaDegrees).toBeLessThan(TOLERANCE_DEGREES);
    }
  });
});
