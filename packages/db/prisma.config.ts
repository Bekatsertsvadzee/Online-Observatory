import path from "node:path";

import { config as loadEnvironment } from "dotenv";
import { defineConfig } from "prisma/config";

loadEnvironment({ path: path.join(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: process.env.DATABASE_URL
    ? {
        url: process.env.DATABASE_URL,
      }
    : undefined,
});
