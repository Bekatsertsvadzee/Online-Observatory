/**
 * Startup checks, run once before this server accepts a request.
 *
 * ADR-012: "A service that cannot sign must refuse to start rather than serve a
 * Collection whose every download is broken." Next calls `register` once per
 * server instance and waits for it, so a missing bucket is a server that never
 * comes up -- rather than one that serves the catalogue happily and answers every
 * download with a 500 that looks like a storage outage.
 *
 * Deliberately only the checks that cannot be made anywhere better. Everything
 * else this app needs from the environment is validated at the point of use,
 * where the error can say which feature is affected.
 */
export async function register() {
  // `register` also runs on the edge runtime, where none of this applies and
  // where the storage signer does not run at all.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // ADR-064: errors go to Sentry only when SENTRY_DSN is set, scrubbed first.
  const { monitoringOptions } = await import("@darkview/monitoring/options");
  const monitoring = monitoringOptions(process.env);
  if (monitoring) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init(monitoring);
  }

  const { getStorageConfiguration } = await import("@darkview/storage/config");

  // Throws with the names of the missing variables and none of their values.
  getStorageConfiguration();

  // ADR-035. A demo never commands hardware, so it does not come up over a
  // database with an observatory in REAL mode. Read straight from the process
  // rather than through the full schema, so this check does not turn every other
  // variable into a startup requirement; any value but `demo` is production here,
  // which is the cautious reading. Only a demo touches the database at startup.
  if (process.env.DARKVIEW_DEPLOYMENT === "demo") {
    const { refuseRealHardwareInDemo } = await import("@/lib/deployment");
    const { getDatabase } = await import("@/lib/db/client");
    // ADR-074: the hardware test observatory, if one is named, is the exception.
    const hardwareTest = process.env.DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID || undefined;
    await refuseRealHardwareInDemo(
      "demo",
      (except) =>
        getDatabase().observatory.count({
          where: { mode: "REAL", ...(except ? { id: { not: except } } : {}) },
        }),
      hardwareTest,
    );
  }
}

/**
 * ADR-064: a request that threw. An answer the API chose -- a 4xx it returns on
 * purpose -- is a response, not a throw, so it never arrives here.
 */
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.SENTRY_DSN?.trim()) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
}
