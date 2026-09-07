import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Realtime tests that need a real PostgreSQL instance.
 *
 * The unit suite runs the link against `FakeLinkStore`, which has no indexes --
 * and the fault these tests exist for is an index. A mission left in a live state
 * holds Mission_active_per_observatory_unique, and only a real database refuses
 * the next mission.
 *
 * Single-threaded for the same reason as the API's: these files share one
 * database. So does the API's suite -- both truncate the same tables -- which is
 * why the root `test:integration` chains them with `&&` rather than running the
 * workspaces in parallel. Two suites against one database fail in ways that have
 * nothing to do with the code under test.
 */
/**
 * Load the repository's `.env`, when there is one.
 *
 * CI sets `DATABASE_URL` and `DATABASE_TEST_URL` in the workflow, so this changes
 * nothing there -- `loadEnvFile` does not overwrite a variable that is already
 * set. It exists for a local run, where the connection string is in `.env` and
 * vitest would otherwise never see it and fall through to a default that assumes
 * a `postgres` role nobody has.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // No .env. CI, or a developer who exports the variables themselves.
}

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
