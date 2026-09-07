import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Tests that need a real PostgreSQL instance.
 *
 * They are kept out of `npm test` because a unit suite that silently needs a
 * database is a unit suite that gets skipped. `npm run test:integration` migrates
 * a database and runs these; CI does the same against a service container.
 *
 * Single-threaded on purpose: these files share one database, and the
 * concurrency under test is inside a file, not between them.
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
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
