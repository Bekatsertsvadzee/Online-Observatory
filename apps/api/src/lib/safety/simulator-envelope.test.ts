import { describe, expect, it } from "vitest";

import {
  SIMULATOR_ENVELOPE_MEASURER,
  admitEnvelopeFor,
  isSimulatorMarked,
} from "@darkview/db/simulator-envelope";

/** The simulator's stand-in limit, stated here rather than defaulted. */
const SIMULATOR_LIMIT_DEGREES = 78;

function envelope(measuredBy: string | null) {
  return {
    maxAltitudeDegrees: SIMULATOR_LIMIT_DEGREES,
    maxAltitudeMeasuredBy: measuredBy,
  };
}

describe("the simulator's stand-in limit (ADR-031)", () => {
  it.each([SIMULATOR_ENVELOPE_MEASURER, "simulator - not a measurement", "  Simulator"])(
    "recognises %j as the simulator's",
    (measuredBy) => {
      expect(isSimulatorMarked(measuredBy)).toBe(true);
    },
  );

  it("does not mistake a person, or nobody, for the simulator", () => {
    expect(isSimulatorMarked("Beka Tsertsvadze")).toBe(false);
    expect(isSimulatorMarked(null)).toBe(false);
  });

  it("stands on a SIMULATED observatory", () => {
    expect(
      admitEnvelopeFor(envelope(SIMULATOR_ENVELOPE_MEASURER), "SIMULATED")
        .maxAltitudeDegrees,
    ).toBe(SIMULATOR_LIMIT_DEGREES);
  });

  it("is UNMEASURED on a REAL one", () => {
    expect(
      admitEnvelopeFor(envelope(SIMULATOR_ENVELOPE_MEASURER), "REAL").maxAltitudeDegrees,
    ).toBeNull();
  });

  it("leaves a measured envelope alone on a REAL observatory", () => {
    expect(
      admitEnvelopeFor(envelope("Beka Tsertsvadze"), "REAL").maxAltitudeDegrees,
    ).toBe(SIMULATOR_LIMIT_DEGREES);
  });
});
