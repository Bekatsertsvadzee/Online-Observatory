/**
 * ADR-035: what a hosted demo is allowed that production is not.
 *
 * No import of the environment module, so the many tests that mock it with only
 * `getServerEnvironment` keep working: the caller passes what it read.
 */
export type DeploymentEnvironment = {
  NODE_ENV: string;
  DARKVIEW_DEPLOYMENT?: "production" | "demo";
};

/**
 * Whether the sandbox payment provider may take a payment here. Outside production
 * always; in production only on a demo deployment, which takes no real money.
 */
export function sandboxMoneyAllowed(environment: DeploymentEnvironment) {
  return environment.NODE_ENV !== "production" || environment.DARKVIEW_DEPLOYMENT === "demo";
}

/**
 * A demo never commands hardware, with one exception (ADR-074): the observatory named by
 * DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID, which no customer can book, may be switched to
 * REAL by an attended operator so the real telescope can be brought up beside the demo.
 */
export function realHardwareAllowedInDemo(
  observatoryId: string,
  hardwareTestObservatoryId: string | undefined,
) {
  return hardwareTestObservatoryId !== undefined && observatoryId === hardwareTestObservatoryId;
}

/**
 * Run once at startup: a demo deployment whose database holds an observatory in REAL
 * mode does not come up, unless that observatory is the hardware test one (ADR-074).
 * The caller counts the REAL observatories other than the one it is given.
 */
export async function refuseRealHardwareInDemo(
  deployment: "production" | "demo" | undefined,
  countRealObservatoriesExcept: (hardwareTestObservatoryId: string | undefined) => Promise<number>,
  hardwareTestObservatoryId?: string,
) {
  if (deployment !== "demo") return;

  const real = await countRealObservatoriesExcept(hardwareTestObservatoryId);
  if (real > 0) {
    throw new Error(
      `DARKVIEW_DEPLOYMENT is demo, but ${real} observatory(ies) are in REAL mode. ` +
        "A demo never commands hardware: switch them to SIMULATED, or do not run this " +
        "database as a demo.",
    );
  }
}
