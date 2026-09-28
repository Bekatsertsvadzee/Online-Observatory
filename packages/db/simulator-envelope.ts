/**
 * The simulator's stand-in for MAX_ALT_SAFE, and the guard that keeps it there (ADR-031).
 *
 * The development seed gives its SIMULATED demo observatories an altitude limit so a
 * simulated mission can slew at all. That number was never measured, so it is
 * recorded under this marker instead of a person's name, and everything that admits
 * an envelope -- the API's loader, the realtime relay, the admin routes, and the
 * agent independently -- reads a marked envelope on anything that is not SIMULATED
 * as UNMEASURED: every slew refused, exactly as if no number had been written.
 *
 * It lives in `packages/db` because both services admit envelopes and must agree.
 * The agent carries its own copy of the rule (`darkview_agent/safety/envelope.py`),
 * and a pytest holds the two marker strings equal.
 */

/** `maxAltitudeMeasuredBy` on a seeded simulator envelope. Not a person. */
export const SIMULATOR_ENVELOPE_MEASURER = "SIMULATOR — NOT A MEASUREMENT";

/**
 * Whether an envelope's provenance is the simulator's.
 *
 * A prefix, case-insensitive, rather than exact equality: a hand-typed variant
 * with a hyphen for the dash is still not a measurement, and no person who
 * measured an optical train is called "Simulator".
 */
export function isSimulatorMarked(measuredBy: string | null | undefined): boolean {
  return (measuredBy ?? "").trim().toUpperCase().startsWith("SIMULATOR");
}

/**
 * The envelope as it may be enforced on an observatory in `mode`.
 *
 * Unchanged, unless it is simulator-marked and the observatory is not SIMULATED;
 * then MAX_ALT_SAFE is withdrawn and the envelope is UNMEASURED. Never the other
 * way round: nothing here can make an unmeasured envelope measured.
 */
export function admitEnvelopeFor<
  T extends {
    maxAltitudeDegrees?: number | null;
    maxAltitudeMeasuredBy?: string | null;
  },
>(envelope: T, mode: "SIMULATED" | "REAL"): T {
  if (mode === "SIMULATED" || !isSimulatorMarked(envelope.maxAltitudeMeasuredBy)) {
    return envelope;
  }
  return { ...envelope, maxAltitudeDegrees: null };
}
