import path from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/**
 * The end-to-end suite: the API and the realtime service in one process, against
 * one real PostgreSQL instance.
 *
 * Both apps alias `@/` to their own `src`, so a single alias cannot serve them.
 * This resolves `@/` by where the importing file lives. A file outside both apps
 * -- the suite itself -- has no answer, and is refused rather than guessed at: it
 * imports each app by relative path, so every line says whose code it means.
 */
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, ".env"));
} catch {
  // No .env. CI, or a developer who exports the variables themselves.
}

const APPS = ["api", "realtime"].map((name) =>
  path.resolve(import.meta.dirname, "apps", name),
);

function appAlias(): Plugin {
  return {
    name: "darkview-app-alias",
    enforce: "pre",
    resolveId(source, importer, options) {
      if (!source.startsWith("@/") || !importer) return null;
      const app = APPS.find((root) => importer.startsWith(root + path.sep));
      if (!app) {
        throw new Error(
          `"${source}" names no app from ${importer}; import it by relative path.`,
        );
      }
      return this.resolve(path.join(app, "src", source.slice(2)), importer, {
        ...options,
        skipSelf: true,
      });
    },
  };
}

export default defineConfig({
  plugins: [appAlias()],
  test: {
    environment: "node",
    include: ["e2e/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
