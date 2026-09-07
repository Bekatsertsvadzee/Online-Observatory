import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@darkview/db";
import { recordAuditEvent } from "@darkview/db/audit";

import type { CommandEnvelope, SafetyEnvelopeConfig } from "@darkview/contracts";

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
import type { ChannelUser, MissionChannelStore, MissionSnapshot } from "@/mission/store";

/**
 * The one store the process runs on: the agent link's surface and the mission
 * channel's, satisfied by a single object over a single connection pool. The two
 * interfaces stay separate so neither channel's code can reach the other's methods.
 */
export type RealtimeStore = LinkStore & MissionChannelStore;

export function createPrismaStore(connectionString: string): RealtimeStore {
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

    /**
     * The link's own history.
     *
     * `Observatory.status` and `linkLostAt` hold only the latest state, which
     * answers "is it up now" and nothing else. An operator reconstructing a night
     * needs to know that the link dropped four times between 22:10 and 22:40, and
     * that is what these rows are for. Both writes are in one transaction with the
     * status change so the account and the state cannot disagree.
     */
    async markLinkUp(observatoryId: string): Promise<void> {
      await database.$transaction(async (tx) => {
        await tx.observatory.update({
          where: { id: observatoryId },
          data: { status: "ONLINE", linkLostAt: null },
        });
        await recordAuditEvent(
          {
            category: "AGENT_LINK",
            action: "AGENT_LINK_UP",
            entityType: "Observatory",
            entityId: observatoryId,
          },
          tx,
        );
      });
    },

    async markLinkLost(observatoryId: string, at: Date): Promise<void> {
      await database.$transaction(async (tx) => {
        await tx.observatory.update({
          where: { id: observatoryId },
          data: { status: "OFFLINE", linkLostAt: at },
        });
        await recordAuditEvent(
          {
            category: "AGENT_LINK",
            action: "AGENT_LINK_LOST",
            entityType: "Observatory",
            entityId: observatoryId,
            detail: { lostAt: at.toISOString() },
          },
          tx,
        );
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

    async findUserBySessionTokenHash(
      tokenHash: string,
      now: Date,
    ): Promise<ChannelUser | null> {
      const session = await database.session.findUnique({
        where: { tokenHash },
        select: {
          expiresAt: true,
          user: { select: { id: true, role: true, emailVerifiedAt: true } },
        },
      });

      // The same three refusals as the API's getCurrentSession: no such session,
      // lapsed, or an account whose email was never verified. An unverified
      // account cannot hold a mission, so it has nothing here to watch.
      if (!session || session.expiresAt <= now || !session.user.emailVerifiedAt) {
        return null;
      }

      return { id: session.user.id, role: session.user.role };
    },

    async loadMissionSnapshot(missionId: string): Promise<MissionSnapshot | null> {
      const mission = await database.mission.findUnique({
        where: { id: missionId },
        select: { id: true, state: true, failureReason: true },
      });
      if (!mission) return null;

      return {
        missionId: mission.id,
        state: mission.state,
        failureReason: mission.failureReason,
      };
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

    async observatoryOwnsMission(
      observatoryId: string,
      missionId: string,
    ): Promise<boolean> {
      const mission = await database.mission.findUnique({
        where: { id: missionId },
        select: { observatoryId: true },
      });
      return mission?.observatoryId === observatoryId;
    },

    async applyMissionEvent(event: MissionEventRecord): Promise<MissionEventOutcome> {
      return database.$transaction(async (tx) => {
        const mission = await tx.mission.findUnique({
          where: { id: event.missionId },
          select: { observatoryId: true, mode: true, isDemo: true },
        });
        if (!mission) return "NOT_FOUND";
        if (mission.observatoryId !== event.observatoryId) return "WRONG_OBSERVATORY";

        // Correlated only to a command this cloud minted for this observatory. An
        // agent reporting an id the cloud does not recognise -- or one belonging
        // to somebody else's observatory -- still gets its transition written; the
        // correlation is simply dropped, because a foreign key to a row that does
        // not exist would fail the write, and losing a real transition over the id
        // beside it is the wrong trade.
        const causedBy = event.commandId
          ? await tx.observatoryCommand.findFirst({
              where: { id: event.commandId, observatoryId: event.observatoryId },
              select: { id: true },
            })
          : null;

        // Written whatever state the mission is in. The event log is an account
        // of what the agent reported, and an event the guard below declines to
        // apply was still reported.
        await tx.missionEvent.create({
          data: {
            missionId: event.missionId,
            state: event.state,
            failureReason: event.failureReason,
            source: "AGENT",
            commandId: causedBy?.id ?? null,
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

        await recordAuditEvent(
          {
            category: "MISSION",
            action: "MISSION_RESOLVED_AFTER_AGENT_RESTART",
            missionId,
            entityType: "Observatory",
            entityId: observatoryId,
            detail: { failureReason: "AGENT_LINK_LOST" },
            isDemo: mission.isDemo,
          },
          tx,
        );

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

      if (count === 1) {
        // Not in a transaction with the update above, because there is none to
        // join: the guarded updateMany is a single statement, and its own WHERE
        // clause is what makes a stale ack lose. A verdict audited here is one
        // that was actually applied.
        await recordAuditEvent(
          {
            category: "COMMAND",
            action: "COMMAND_VERDICT_RECORDED",
            commandId: verdict.commandId,
            entityType: "Observatory",
            entityId: verdict.observatoryId,
            detail: {
              status: verdict.status,
              rejectionReason: verdict.rejectionReason,
              detail: verdict.detail,
              decidedAt: verdict.decidedAt.toISOString(),
            },
          },
          database,
        );
      }

      return count === 1 ? "RECORDED" : "IGNORED_STALE";
    },

    async loadSafetyEnvelope(
      observatoryId: string,
    ): Promise<SafetyEnvelopeConfig | null> {
      const row = await database.safetyEnvelope.findUnique({
        where: { observatoryId },
        include: {
          horizonMask: { orderBy: { azimuthDegrees: "asc" } },
          forbiddenAzimuthSectors: true,
        },
      });
      if (!row) return null;

      // The same mapping exists in apps/api's safety store. Duplicated for the
      // same reason as LIVE_MISSION_STATES: this service does not depend on the
      // Next.js app. If the contract changes, both change.
      return {
        observatoryId: row.observatoryId,
        minAltitudeDegrees: row.minAltitudeDegrees,
        maxAltitudeDegrees: row.maxAltitudeDegrees,
        maxAltitudeMeasuredAt: row.maxAltitudeMeasuredAt?.toISOString() ?? null,
        maxAltitudeMeasuredBy: row.maxAltitudeMeasuredBy,
        maxAltitudeMeasurementNote: row.maxAltitudeMeasurementNote,
        horizonMask: row.horizonMask.map((entry) => ({
          azimuthDegrees: entry.azimuthDegrees,
          minAltitudeDegrees: entry.minAltitudeDegrees,
        })),
        forbiddenAzimuthSectors: row.forbiddenAzimuthSectors.map((sector) => ({
          fromDegrees: sector.fromDegrees,
          toDegrees: sector.toDegrees,
        })),
        sunExclusionDegrees: row.sunExclusionDegrees,
        daylightLockSunAltitudeDegrees: row.daylightLockSunAltitudeDegrees,
        nudgeMaxDegrees: row.nudgeMaxDegrees,
        nudgeRateDegreesPerSecond: row.nudgeRateDegreesPerSecond,
        slewTimeoutSeconds: row.slewTimeoutSeconds,
        heartbeatLossSeconds: row.heartbeatLossSeconds,
        linkDeadSeconds: row.linkDeadSeconds,
        refocusTemperatureDeltaC: row.refocusTemperatureDeltaC,
        updatedAt: row.updatedAt.toISOString(),
      };
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
