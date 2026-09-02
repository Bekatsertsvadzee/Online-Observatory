import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@darkview/db";
import { getServerEnvironment } from "@/lib/validation/env";

const globalDatabase = globalThis as unknown as { database?: PrismaClient };

function createDatabaseClient() {
  const environment = getServerEnvironment();
  const adapter = new PrismaPg({ connectionString: environment.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export function getDatabase() {
  if (!globalDatabase.database) {
    globalDatabase.database = createDatabaseClient();
  }

  return globalDatabase.database;
}
