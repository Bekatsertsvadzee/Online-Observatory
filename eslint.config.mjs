import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    settings: {
      next: { rootDir: "apps/api" },
    },
  },
  globalIgnores([
    "**/.next/**",
    "**/coverage/**",
    "packages/db/generated/**",
    "packages/contracts/generated/**",
    "agent/.venv/**",
    "agent/contracts/**",
  ]),
]);
