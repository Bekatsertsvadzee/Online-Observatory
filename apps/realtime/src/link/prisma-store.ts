import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@darkview/db";

import type { InboundMessageRecord, LinkStore, ObservatoryRecord } from "@/link/store";

export function createPrismaStore(connectionString: string): LinkStore {
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  return {
    async findObservatoryByTokenHash(tokenHash: string): Promise<ObservatoryRecord | null> {
      const observatory = await database.observatory.findUnique({
        where: { deviceTokenHash: tokenHash },
        select: { id: true, slug: true, mode: true },
      });
      return observatory;
    },

    async recordInboundMessage(message: InboundMessageRecord): Promise<boolean> {
      // The unique primary key does the deduplication. A replayed message loses
      // the race with its own earlier self and is skipped, which is exactly the
      // behaviour the agent's replay depends on.
      const written = await database.agentMessage.createMany({
        data: [message],
        skipDuplicates: true,
      });
      return written.count === 1;
    },

    async markLinkUp(observatoryId: string): Promise<void> {
      await database.observatory.update({
        where: { id: observatoryId },
        data: { status: "ONLINE", linkLostAt: null },
      });
    },

    async markLinkLost(observatoryId: string, at: Date): Promise<void> {
      await database.observatory.update({
        where: { id: observatoryId },
        data: { status: "OFFLINE", linkLostAt: at },
      });
    },
  };
}
