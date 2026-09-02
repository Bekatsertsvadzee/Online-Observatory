import { describe, expect, it } from "vitest";

import {
  DEMO_CAPTURES,
  DEMO_MISSIONS,
  DEMO_TARGETS,
  assertDevelopmentSeedData,
} from "@darkview/db/development-seed";

describe("development seed data", () => {
  it("marks catalog data as demo and observations as simulated", () => {
    expect(assertDevelopmentSeedData).not.toThrow();
    expect(DEMO_TARGETS.every((target) => target.isDemo)).toBe(true);
    expect(DEMO_MISSIONS.every((mission) => mission.isDemo && mission.simulated)).toBe(
      true,
    );
    expect(DEMO_CAPTURES.every((capture) => capture.isDemo && capture.simulated)).toBe(
      true,
    );
  });

  it("uses unmistakable demo identifiers", () => {
    expect(DEMO_TARGETS.every((target) => target.catalogId.startsWith("DEMO-"))).toBe(
      true,
    );
    expect(DEMO_CAPTURES.every((capture) => capture.id.startsWith("CAP-DEMO-"))).toBe(
      true,
    );
  });
});
