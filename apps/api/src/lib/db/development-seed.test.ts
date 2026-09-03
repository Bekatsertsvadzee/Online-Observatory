import { describe, expect, it } from "vitest";

import {
  DEMO_CAPTURES,
  DEMO_MISSIONS,
  assertDevelopmentSeedData,
} from "@darkview/db/development-seed";

describe("development seed data", () => {
  it("marks every seeded observation as demo and simulated", () => {
    expect(assertDevelopmentSeedData).not.toThrow();
    expect(
      DEMO_MISSIONS.every((mission) => mission.isDemo && mission.mode === "SIMULATED"),
    ).toBe(true);
    expect(
      DEMO_CAPTURES.every((capture) => capture.isDemo && capture.mode === "SIMULATED"),
    ).toBe(true);
  });

  it("uses unmistakable demo identifiers", () => {
    expect(DEMO_CAPTURES.every((capture) => capture.id.startsWith("CAP-DEMO-"))).toBe(
      true,
    );
  });
});
