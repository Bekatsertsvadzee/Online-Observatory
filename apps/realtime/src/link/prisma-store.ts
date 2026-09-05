import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@darkview/db";

import type { CommandEnvelope } from "@darkview/contracts";

import {
  COMMAND_STATUS_FOR,
  LIVE_MISSION_STATES,
  TERMINAL_COMMAND_STATUSES,
  TERMINAL_MISSION_STATES,
  isTerminalCommandStatus,
  type ActiveSession,
  type CommandVerdictOutcome,
  type CommandVerdictRecord,
  type InboundMessageRecord,
  type LinkStore,
  type MissionEventOutcome,
  type MissionEventRecord,
  type ObservatoryRecord,
  type RelayableCommand,
  type ResumeOutcome,
} from "@/link/store";

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

    async applyMissionEvent(event: MissionEventRecord): Promise<MissionEventOutcome> {
      return database.$transaction(async (tx) => {
        const mission = await tx.mission.findUnique({
          where: { id: event.missionId },
          select: { observatoryId: true, mode: true, isDemo: true },
        });
        if (!mission) return "NOT_FOUND";
        if (mission.observatoryId !== event.observatoryId) return "WRONG_OBSERVATORY";

        // Written whatever state the mission is in. The event log is an account
        // of what the agent reported, and an event the guard below declines to
        // apply was still reported.
        await tx.missionEvent.create({
          data: {
            missionId: event.missionId,
            state: event.state,
            source: "AGENT",
            message: event.detail,
            occurredAt: event.occurredAt,
            // `CLAUDE.md`: a mission run against the simulator is permanently
            // marked SIMULATED and never presented as real telescope output.
            // Letting these default to false would file simulator events as real.
            simulated: mission.mode === "SIMULATED",
            isDemo: mission.isDemo,
          },
        });

        // The terminal guard is the WHERE clause rather than a branch on the row
        // read above. Two events for one mission can be in flight at once -- the
        // socket handler does not serialise them -- and a read-then-write would
        // let whichever arrived second win.
        const { count } = await tx.mission.updateMany({
          where: {
            id: event.missionId,
            observatoryId: event.observatoryId,
            state: { notIn: [...TERMINAL_MISSION_STATES] },
          },
          data: { state: event.state, failureReason: event.failureReason },
        });

        return count === 1 ? "APPLIED" : "RECORDED";
      });
    },

    async resolveResumedMission(input: {
      observatoryId: string;
      missionId: string;
      now: Date;
    }): Promise<ResumeOutcome> {
      const { observatoryId, missionId, now } = input;

      return database.$transaction(async (tx) => {
        const mission = await tx.mission.findUnique({
          where: { id: missionId },
          select: { observatoryId: true, mode: true, isDemo: true },
        });
        if (!mission) return "NOT_FOUND";
        if (mission.observatoryId !== observatoryId) return "WRONG_OBSERVATORY";

        const { count } = await tx.mission.updateMany({
          where: {
            id: missionId,
            observatoryId,
            state: { in: [...LIVE_MISSION_STATES] },
          },
          data: { state: "FAILED", failureReason: "AGENT_LINK_LOST" },
        });
        // Already finished. The agent reports the same id on every attempt until
        // the link is genuinely online, so a second restart before it got through
        // arrives here twice; that is the recovery path working, not an error.
        if (count === 0) return "NOT_LIVE";

        // CLOUD, not AGENT: the agent reported which mission it was holding, the
        // cloud decided the outcome. Who resolved a mission belongs in the trail.
        await tx.missionEvent.create({
          data: {
            missionId,
            state: "FAILED",
            source: "CLOUD",
            message:
              "Agent restarted holding this mission. The mount parked locally and the cloud closed the mission out.",
            occurredAt: now,
            simulated: mission.mode === "SIMULATED",
            isDemo: mission.isDemo,
          },
        });

        // The mission is over, so nobody owns it. Leaving the session alive would
        // leave the agent holding an owner for a mission that no longer exists.
        await tx.missionSession.updateMany({
          where: { missionId, revokedAt: null },
          data: { revokedAt: now, revokedFor: "AGENT_LINK_LOST" },
        });

        return "RESOLVED";
      });
    },

    async recordCommandVerdict(
      verdict: CommandVerdictRecord,
    ): Promise<CommandVerdictOutcome> {
      const command = await database.observatoryCommand.findUnique({
        where: { id: verdict.commandId },
        select: { observatoryId: true },
      });
      // Logged and dropped, never created. A row here is a command the cloud
      // minted; an agent that could insert one could invent its own authority.
      if (!command) return "NOT_FOUND";
      if (command.observatoryId !== verdict.observatoryId) return "WRONG_OBSERVATORY";

      const status = COMMAND_STATUS_FOR[verdict.status];
      if (status === null) return "DUPLICATE_ACK";

      const { count } = await database.observatoryCommand.updateMany({
        where: {
          id: verdict.commandId,
          observatoryId: verdict.observatoryId,
          status: { notIn: [...TERMINAL_COMMAND_STATUSES] },
        },
        data: {
          status,
          completedAt: isTerminalCommandStatus(status) ? verdict.decidedAt : undefined,
          // JSON rather than columns. `CommandRejectionReason` is the agent's
          // vocabulary and several of its values are not `ErrorCode` values; a
          // Postgres enum here would have to be migrated in step with the
          // contract, and a reason it had not learned yet would be unstorable.
          result: {
            status: verdict.status,
            rejectionReason: verdict.rejectionReason,
            detail: verdict.detail,
            decidedAt: verdict.decidedAt.toISOString(),
          },
        },
      });

      return count === 1 ? "RECORDED" : "IGNORED_STALE";
    },

    async liveMissionId(observatoryId: string): Promise<string | null> {
      // At most one can exist: Mission_active_per_observatory_unique is a partial
      // unique index over exactly these states.
      const mission = await database.mission.findFirst({
        where: { observatoryId, state: { in: [...LIVE_MISSION_STATES] } },
        select: { id: true },
      });
      return mission?.id ?? null;
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
