import "server-only";

import {
  getStorageConfiguration,
  type StorageConfiguration,
} from "@darkview/storage/config";

/**
 * Object storage configuration, read once.
 *
 * Cached rather than re-parsed per request, and not read at module load: a throw
 * at import time in a route module is a build-time failure with a stack trace
 * pointing at the wrong thing.
 *
 * By the time anything calls this, `src/instrumentation.ts` has already proved
 * the configuration parses -- ADR-012 has the server refuse to start without it.
 * This is therefore a cache rather than a check, and nothing here supplies a
 * fallback for a value that has already been shown to exist.
 */
let cached: StorageConfiguration | null = null;

export function getStorage(): StorageConfiguration {
  cached ??= getStorageConfiguration();
  return cached;
}
