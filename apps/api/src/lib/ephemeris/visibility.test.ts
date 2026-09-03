import { describe, expect, it } from "vitest";

import { PHASE1_TARGETS } from "@darkview/db/phase1-catalogue";
import { zTargetVisibility } from "@darkview/contracts/zod";

import { evaluateVisibility, type VisibilityInput } from "@/lib/ephemeris/visibility";

const site = { latitudeDegrees: 41.7151, longitudeDegrees: 44.8271 };

/**
 * A FABRICATED clearance, for tests only.
 *
 * MAX_ALT_SAFE is measured from the assembled optical train during mount
 * qualification (DV-034). No real value exists yet, and none may appear in this
 * repository -- the agent's test_no_default_max_altitude guard scans for exactly
 * that, including in fixtures, because a fixture default is how an unmeasured
 * number ends up looking measured.
 *
 * Deliberately not 72: that is the figure earlier planning material printed as
 * "provisional", and it must never gain the appearance of having been measured.
 */
const FABRICATED_CLEARANCE_DEGREES = 65;

/** Low enough that any visible target trips the ceiling. Also fabricated. */
const DELIBERATELY_LOW_CEILING_DEGREES = 5;

const measured = {
  maxAltitudeDegrees: FABRICATED_CLEARANCE_DEGREES,
  minAltitudeDegrees: 25,
};
const online = { online: true, weatherHold: false };

function targetBySlug(slug: string) {
  const found = PHASE1_TARGETS.find((t) => t.slug === slug);
  if (!found) throw new Error(`${slug} not in the catalogue`);
  return found as unknown as VisibilityInput["target"];
}

function evaluate(overrides: Partial<VisibilityInput> = {}) {
  return evaluateVisibility({
    target: targetBySlug("m13-hercules-cluster"),
    site,
    envelope: measured,
    observatory: online,
    at: new Date("2026-09-03T21:00:00Z"),
    ...overrides,
  });
}

describe("visibility is computed, never looked up", () => {
  // criterion 1
  it("returns a different altitude an hour later for a fixed target", () => {
    const first = evaluate({ at: new Date("2026-09-03T21:00:00Z") });
    const later = evaluate({ at: new Date("2026-09-03T22:00:00Z") });

    expect(first.horizontal.altitudeDegrees).not.toBe(later.horizontal.altitudeDegrees);
    // an hour of Earth rotation is about 15 degrees of hour angle, so the
    // altitude must move meaningfully, not merely differ in the last decimal
    expect(
      Math.abs(first.horizontal.altitudeDegrees - later.horizontal.altitudeDegrees),
    ).toBeGreaterThan(1);
  });

  it("returns a different position an hour later for a moving target", () => {
    const moon = targetBySlug("moon-terminator");
    const first = evaluate({ target: moon, at: new Date("2026-09-03T21:00:00Z") });
    const later = evaluate({ target: moon, at: new Date("2026-09-03T22:00:00Z") });

    expect(first.horizontal.altitudeDegrees).not.toBe(later.horizontal.altitudeDegrees);
  });

  it("produces a body the contract's own schema accepts", () => {
    expect(() => zTargetVisibility.parse(evaluate())).not.toThrow();
  });
});

// criterion 5
describe("an unmeasured safety envelope blocks everything", () => {
  it.each(PHASE1_TARGETS.map((t) => t.slug))(
    "%s reports SAFETY_ENVELOPE_UNMEASURED and is not observable",
    (slug) => {
      const result = evaluate({
        target: targetBySlug(slug),
        envelope: { maxAltitudeDegrees: null, minAltitudeDegrees: 25 },
      });

      expect(result.blockReasons).toContain("SAFETY_ENVELOPE_UNMEASURED");
      expect(result.observable).toBe(false);
    },
  );

  it("blocks equally when no envelope row exists at all", () => {
    const result = evaluate({ envelope: null });
    expect(result.blockReasons).toContain("SAFETY_ENVELOPE_UNMEASURED");
    expect(result.observable).toBe(false);
  });
});

// criterion 2
describe("every rejection names a reason", () => {
  it("blocks a disabled target with TARGET_DISABLED", () => {
    const result = evaluate({
      target: { ...targetBySlug("m13-hercules-cluster"), enabled: false },
    });
    expect(result.blockReasons).toContain("TARGET_DISABLED");
  });

  it("blocks an offline observatory with OBSERVATORY_OFFLINE", () => {
    const result = evaluate({ observatory: { online: false, weatherHold: false } });
    expect(result.blockReasons).toContain("OBSERVATORY_OFFLINE");
  });

  it("blocks a weather hold with WEATHER_HOLD", () => {
    const result = evaluate({ observatory: { online: true, weatherHold: true } });
    expect(result.blockReasons).toContain("WEATHER_HOLD");
  });

  it("blocks daylight with SUN_TOO_HIGH", () => {
    const result = evaluate({ at: new Date("2026-09-03T09:00:00Z") });
    expect(result.blockReasons).toContain("SUN_TOO_HIGH");
  });

  it("blocks a target under the horizon with BELOW_HORIZON", () => {
    // M42 is a winter object; in September it is below the horizon at this hour.
    const result = evaluate({
      target: targetBySlug("m42-orion-nebula"),
      at: new Date("2026-09-03T21:00:00Z"),
    });
    expect(result.blockReasons).toContain("BELOW_HORIZON");
    expect(result.horizontal.altitudeDegrees).toBeLessThan(0);
  });

  it("blocks above the measured envelope with ABOVE_MAX_ALTITUDE", () => {
    const result = evaluate({
      envelope: {
        maxAltitudeDegrees: DELIBERATELY_LOW_CEILING_DEGREES,
        minAltitudeDegrees: 0,
      },
      target: { ...targetBySlug("m13-hercules-cluster"), minAltitudeDegrees: 0 },
    });
    expect(result.blockReasons).toContain("ABOVE_MAX_ALTITUDE");
  });

  it("blocks the Moon with DOES_NOT_FIT_FIELD, because 31' exceeds every field", () => {
    const result = evaluate({ target: targetBySlug("moon-terminator") });
    expect(result.blockReasons).toContain("DOES_NOT_FIT_FIELD");
  });

  it("never reports observable while any reason is present", () => {
    for (const slug of PHASE1_TARGETS.map((t) => t.slug)) {
      const result = evaluate({ target: targetBySlug(slug) });
      expect(result.observable).toBe(result.blockReasons.length === 0);
    }
  });

  it("gives every target an assessment rather than omitting it", () => {
    const assessed = PHASE1_TARGETS.map((t) => evaluate({ target: targetBySlug(t.slug) }));

    expect(assessed).toHaveLength(12);
    for (const result of assessed) {
      expect(result.evaluatedAt).toBeTruthy();
      expect(Number.isFinite(result.sunAltitudeDegrees)).toBe(true);
      expect(Number.isFinite(result.moonSeparationDegrees)).toBe(true);
      expect(Array.isArray(result.blockReasons)).toBe(true);
    }
  });
});
