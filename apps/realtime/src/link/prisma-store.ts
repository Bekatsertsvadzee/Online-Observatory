import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@darkview/db";

import type { CommandEnvelope } from "@darkview/contracts";

import type {
  ActiveSession,
  InboundMessageRecord,
  LinkStore,
  ObservatoryRecord,
  RelayableCommand,
} from "@/link/store";

/**
 * The mission states during which a session may command the mount.
 *
 * The same list as `LIVE_MISSION_STATES` in the API's mission orchestrator and
 * as the predicate of Mission_active_per_observatory_unique. Duplicated rather
 * than imported because this service does not depend on the Next.js app; if one
 * changes, all three change.
 */
const LIVE_MISSION_STATES = [
  "PREPARING",
  "SLEWING",
  "VERIFYING",
  "CENTERING",
  "OBSERVING",
  "CAPTURING",
] as const;

export function createPrismaStore(connectionString: string): LinkStore {
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  return {
    async findObservatoryByTokenHash(
      tokenHash: string,
    ): Promise<ObservatoryRecord | null> {
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

    async loadCommand(commandId: string): Promise<RelayableCommand | null> {
      const row = await database.observatoryCommand.findUnique({
        where: { id: commandId },
      });
      return row ? toRelayable(row) : null;
    },

    async pendingCommands(observatoryId: string, now: Date) {
      const rows = await database.observatoryCommand.findMany({
        where: { observatoryId, relayedAt: null, expiresAt: { gt: now } },
        orderBy: { issuedAt: "asc" },
        take: PENDING_SWEEP_LIMIT,
      });
      return rows.map(toRelayable);
    },

    async markCommandRelayed(commandId: string, at: Date): Promise<void> {
      await database.observatoryCommand.update({
        where: { id: commandId },
        data: { relayedAt: at, status: "EXECUTING" },
      });
    },

    async loadSession(sessionId: string): Promise<ActiveSession | null> {
      const session = await database.missionSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          missionId: true,
          userId: true,
          expiresAt: true,
          revokedAt: true,
        },
      });
      if (!session || session.revokedAt !== null) return null;
      return toActiveSession(session);
    },

    async activeSession(observatoryId: string, now: Date): Promise<ActiveSession | null> {
      const session = await database.missionSession.findFirst({
        where: {
          revokedAt: null,
          expiresAt: { gt: now },
          mission: { observatoryId, state: { in: [...LIVE_MISSION_STATES] } },
        },
        orderBy: { issuedAt: "desc" },
        select: { id: true, missionId: true, userId: true, expiresAt: true },
      });
      return session ? toActiveSession(session) : null;
    },
  };
}

function toActiveSession(row: {
  id: string;
  missionId: string;
  userId: string;
  expiresAt: Date;
}): ActiveSession {
  return {
    sessionId: row.id,
    missionId: row.missionId,
    userId: row.userId,
    expiresAt: row.expiresAt,
  };
}

/**
 * A bounded sweep. If there are ever more unrelayed commands than this for one
 * observatory, something is wrong upstream and draining them all in one pass would
 * turn a fault into a flood of mount instructions.
 */
const PENDING_SWEEP_LIMIT = 50;

/**
 * The stored row back into the envelope the orchestrator minted.
 *
 * `payload` is stored as sent and returned as sent. It is not rebuilt from the
 * other columns: the audit has to show what actually crossed the boundary.
 */
function toRelayable(row: {
  id: string;
  missionId: string;
  sessionId: string;
  userId: string;
  observatoryId: string;
  type: string;
  issuedAt: Date;
  expiresAt: Date;
  payload: unknown;
}): RelayableCommand {
  return {
    observatoryId: row.observatoryId,
    envelope: {
      commandId: row.id,
      missionId: row.missionId,
      sessionId: row.sessionId,
      userId: row.userId,
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      type: row.type as CommandEnvelope["type"],
      payload: row.payload as CommandEnvelope["payload"],
    },
  };
}
