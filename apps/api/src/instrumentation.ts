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

  const { getStorageConfiguration } = await import("@darkview/storage/config");

  // Throws with the names of the missing variables and none of their values.
  getStorageConfiguration();
}
