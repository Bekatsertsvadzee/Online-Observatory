import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Tests needing a real database live in vitest.integration.config.ts. Running
    // them here would make `npm test` fail on any machine without PostgreSQL.
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
  },
});
