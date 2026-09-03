import { describe, expect, it } from "vitest";

import {
  EXCLUDED_TARGETS,
  PHASE1_TARGETS,
  WIDEST_FIELD_ARCMIN,
} from "@darkview/db/phase1-catalogue";
import { zTarget } from "@darkview/contracts/zod";

/**
 * DV-052. The catalogue is Build Plan section 01 and nothing else. These are the
 * assertions that keep it that way as people add "just one more" object.
 */
describe("the Phase 1 catalogue", () => {
  // criterion 1
  it("holds exactly twelve targets", () => {
    expect(PHASE1_TARGETS).toHaveLength(12);
  });

  it("has a unique slug and id for each", () => {
    expect(new Set(PHASE1_TARGETS.map((t) => t.slug)).size).toBe(12);
    expect(new Set(PHASE1_TARGETS.map((t) => t.id)).size).toBe(12);
  });

  // criterion 2
  it("names every target in both English and Georgian", () => {
    for (const target of PHASE1_TARGETS) {
      expect(target.nameEn.trim(), target.slug).not.toBe("");
      expect(target.nameKa.trim(), target.slug).not.toBe("");
      // Georgian, not a placeholder copy of the English name.
      expect(target.nameKa, target.slug).toMatch(/\p{Script=Georgian}/u);
    }
  });

  // criterion 3 -- the Build Plan states a configuration per target
  it.each([
    ["moon-terminator", "F10_NATIVE"],
    ["jupiter", "F20_BARLOW"],
    ["saturn", "F20_BARLOW"],
    ["mars", "F20_BARLOW"],
    ["venus", "F20_BARLOW"],
    ["albireo", "F10_NATIVE"],
    ["mizar-alcor", "F10_NATIVE"],
    ["m13-hercules-cluster", "F6_3_REDUCER"],
    ["m57-ring-nebula", "F10_NATIVE"],
    ["m27-dumbbell-nebula", "F6_3_REDUCER"],
    ["m42-orion-nebula", "F6_3_REDUCER"],
    ["m15-globular-cluster", "F6_3_REDUCER"],
  ])("%s uses the Build Plan's configuration %s", (slug, opticalConfig) => {
    const target = PHASE1_TARGETS.find((t) => t.slug === slug);
    expect(target, `${slug} is missing from the catalogue`).toBeDefined();
    expect(target?.opticalConfig).toBe(opticalConfig);
  });

  // criterion 4
  it("ships no preview image, because no operator image exists yet", () => {
    for (const target of PHASE1_TARGETS) {
      expect(target).not.toHaveProperty("previewImageUrl");
    }
  });

  // criterion 5
  it.each(EXCLUDED_TARGETS)("excludes $name, which does not fit the field", (excluded) => {
    const names = PHASE1_TARGETS.map((t) => `${t.nameEn} ${t.slug} ${t.catalogId ?? ""}`)
      .join(" ")
      .toLowerCase();

    expect(names).not.toContain("andromeda");
    expect(names).not.toContain("m31");
    expect(names).not.toContain("pleiades");
    expect(names).not.toContain("double cluster");

    // and the reason, not just the fact
    expect(excluded.angularSizeArcmin).toBeGreaterThan(WIDEST_FIELD_ARCMIN);
  });

  it("holds nothing wider than the widest configuration, except the Moon", () => {
    const oversized = PHASE1_TARGETS.filter(
      (t) => t.angularSizeArcmin > WIDEST_FIELD_ARCMIN,
    );
    // The Moon is 31' and fits no configuration whole; the product is the
    // terminator close-up, which the Build Plan calls a feature, not a defect.
    expect(oversized.map((t) => t.slug)).toEqual([]);
  });
});

describe("target positions", () => {
  it("gives the Moon and the planets no stored coordinates", () => {
    const moving = PHASE1_TARGETS.filter((t) => t.positionSource === "EPHEMERIS");

    expect(moving.map((t) => t.slug).sort()).toEqual([
      "jupiter",
      "mars",
      "moon-terminator",
      "saturn",
      "venus",
    ]);

    for (const target of moving) {
      expect(target.rightAscensionHours, target.slug).toBeNull();
      expect(target.declinationDegrees, target.slug).toBeNull();
      expect(target.solarSystemBody, target.slug).not.toBeNull();
    }
  });

  it("gives every fixed target real J2000 coordinates", () => {
    const fixed = PHASE1_TARGETS.filter((t) => t.positionSource === "FIXED");
    expect(fixed).toHaveLength(7);

    for (const target of fixed) {
      expect(target.rightAscensionHours, target.slug).toBeGreaterThanOrEqual(0);
      expect(target.rightAscensionHours, target.slug).toBeLessThan(24);
      expect(target.declinationDegrees, target.slug).toBeGreaterThanOrEqual(-90);
      expect(target.declinationDegrees, target.slug).toBeLessThanOrEqual(90);
      expect(target.solarSystemBody, target.slug).toBeNull();
    }
  });

  it("produces rows the contract's own Target schema accepts", () => {
    for (const target of PHASE1_TARGETS) {
      const candidate = {
        ...target,
        catalogId: target.catalogId,
        coordinates:
          target.positionSource === "FIXED"
            ? {
                raHours: target.rightAscensionHours,
                decDegrees: target.declinationDegrees,
                epoch: "J2000",
              }
            : null,
        previewImageUrl: null,
        enabled: true,
      };
      delete (candidate as Record<string, unknown>).rightAscensionHours;
      delete (candidate as Record<string, unknown>).declinationDegrees;

      expect(() => zTarget.parse(candidate), target.slug).not.toThrow();
    }
  });
});
