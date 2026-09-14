import "server-only";

import { randomUUID } from "node:crypto";

import type { ErrorCode, GotoPayload, MissionSession } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { COMMAND_TTL_SECONDS } from "@/features/missions/command";
import { getDatabase } from "@/lib/db/client";
import { horizontalAirlessOf } from "@/lib/ephemeris/engine";
import { equatorialFor } from "@/lib/ephemeris/visibility";
import { notifyAgent } from "@/lib/observatory/relay";
import { evaluatePointing, isMeasured } from "@/lib/safety/envelope";
import { loadSafetyEnvelope, siteOf } from "@/lib/safety/store";

/**
 * The states during which a mission may command the mount.
 *
 * The same list is the predicate of Mission_active_per_observatory_unique in the
 * DV-058 migration. If one changes the other must, and the database is the one
 * that actually stops two live missions.
 */
export const LIVE_MISSION_STATES = [
  "PREPARING",
  "SLEWING",
  "VERIFYING",
  "CENTERING",
  "OBSERVING",
  "CAPTURING",
] as const;

/**
 * The states a mission never leaves.
 *
 * Nothing resumes from one, which is what separates them from the hold states:
 * WEATHER_HOLD and NOT_VISIBLE are a mission waiting, and a mission waiting may
 * still become observable. These are the ones where an undelivered promise is
 * final -- the realtime service keeps the same list for the same reason
 * (`TERMINAL_MISSION_STATES` in `apps/realtime/src/link/store.ts`), and the two
 * are not shared only because neither service imports the other.
 */
export const TERMINAL_MISSION_STATES = ["COMPLETE", "CANCELLED", "FAILED"] as const;

/**
 * How long a session owns the telescope when no booking bounds it.
 *
 * A booked mission gets the end of its slot instead, which is the honest answer:
 * the customer paid for a half hour and the session should not outlive it. This
 * constant covers operator and demo missions, which have no booking.
 */
export const UNBOOKED_SESSION_MINUTES = 30;

/** What a customer may cause to be minted. The contract's ClientCommandType. */
export const ALLOWED_CLIENT_COMMANDS = ["NUDGE", "CAPTURE", "RECENTER", "ABORT"] as const;

export type SessionFailure = {
  ok: false;
  status: 403 | 404 | 409;
  code: ErrorCode;
  message: string;
};

export type SessionSuccess = { ok: true; session: MissionSession };
export type SessionResult = SessionSuccess | SessionFailure;

function toContractSession(row: {
  id: string;
  missionId: string;
  userId: string;
  issuedAt: Date;
  expiresAt: Date;
}): MissionSession {
  return {
    sessionId: row.id,
    missionId: row.missionId,
    userId: row.userId,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    missionChannelUrl: `/ws/mission/${row.missionId}`,
    allowedCommands: [...ALLOWED_CLIENT_COMMANDS],
  };
}

/**
 * Open the live session and become the single active session owner.
 *
 * Exclusivity is MissionSession_active_owner_unique, not a check in this function.
 * Two requests arriving together both see no owner; one insert survives, and that
 * rejection is the 409. There is deliberately no "is anyone else here?" query
 * guarding the insert, for the same reason DV-055 has no availability query
 * guarding a booking: such a check cannot be correct under concurrency, and having
 * one would let this appear to work after the index was dropped.
 *
 * A second start by the owner themselves is not a second session. It rotates:
 * the old row is revoked and a new sessionId is issued. That is what the contract
 * means by the agent refusing "any command whose sessionId does not match the value
 * it last received" -- it is how a stale browser tab stops being able to drive the
 * telescope when the customer reloads the page.
 */
export async function startMissionSession(input: {
  missionId: string;
  actor: { id: string; role: "USER" | "OPERATOR" };
  now: Date;
}): Promise<SessionResult> {
  const database = getDatabase();
  const { missionId, actor, now } = input;

  const mission = await database.mission.findUnique({
    where: { id: missionId },
    include: {
      observatory: { include: { weatherState: true } },
      target: true,
      booking: { select: { slotStartAt: true, durationMinutes: true, targetId: true } },
    },
  });

  // Existence is private: a stranger probing mission ids learns nothing from a
  // 403 that they would not learn from a 404, so they get the 404.
  if (!mission || (actor.role !== "OPERATOR" && mission.userId !== actor.id)) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such mission." };
  }

  // ADR-018: a scheduled mission is started by the customer who booked it. An
  // operator reaches a live mission through the override, not by starting one.
  const scheduled = mission.state === "SCHEDULED";
  if (scheduled && mission.userId !== actor.id) {
    return {
      ok: false,
      status: 409,
      code: "SESSION_NOT_OWNER",
      message: "Only the customer who booked this mission may start it.",
    };
  }

  if (
    !scheduled &&
    !LIVE_MISSION_STATES.includes(mission.state as (typeof LIVE_MISSION_STATES)[number])
  ) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: `A mission in ${mission.state} has no live session to open.`,
    };
  }

  // Criterion 7. Checked before anything is written: refusing after issuing a
  // session would leave a customer holding a telescope that cannot move.
  if (mission.observatory.status !== "ONLINE") {
    return {
      ok: false,
      status: 409,
      code: "OBSERVATORY_OFFLINE",
      message: "The observatory is offline.",
    };
  }
  if (mission.observatory.weatherState?.holdActive) {
    return {
      ok: false,
      status: 409,
      code: "WEATHER_HOLD",
      message: "The observatory is on weather hold.",
    };
  }

  const expiresAt = sessionExpiry(mission.booking, now);
  if (expiresAt <= now) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: "The booked slot for this mission has already ended.",
    };
  }

  if (scheduled) {
    return startScheduledMission({ mission, actorId: actor.id, now, expiresAt });
  }

  try {
    const opened = await database.$transaction(async (tx) => {
      // Sweep what the index cannot see. A predicate cannot compare against now(),
      // so a lapsed session still occupies the unique index until something
      // revokes it, and that something is the next request through this path.
      await tx.missionSession.updateMany({
        where: { missionId, revokedAt: null, expiresAt: { lte: now } },
        data: { revokedAt: now, revokedFor: "EXPIRED" },
      });

      // Rotation: the owner reopening replaces their own session, which is what
      // invalidates the sessionId a stale tab is still holding.
      await tx.missionSession.updateMany({
        where: { missionId, revokedAt: null, userId: actor.id },
        data: { revokedAt: now, revokedFor: "REPLACED_BY_OWNER" },
      });

      const session = await tx.missionSession.create({
        data: {
          missionId,
          userId: actor.id,
          issuedAt: now,
          expiresAt,
          isDemo: mission.isDemo,
        },
      });

      // Criterion 5. Inside the transaction, so the agent is never told about a
      // session owner that did not commit.
      await notifyAgent(tx, {
        kind: "SESSION",
        observatoryId: mission.observatoryId,
        missionId,
        sessionId: session.id,
      });

      // In the transaction for the same reason. Who held the telescope, and from
      // when until when, is the first question asked about any observation.
      await recordAuditEvent(
        {
          category: "MISSION",
          action: "MISSION_SESSION_OPENED",
          actorUserId: actor.id,
          missionId,
          entityType: "MissionSession",
          entityId: session.id,
          detail: {
            actorRole: actor.role,
            expiresAt: expiresAt.toISOString(),
            bounded: mission.booking ? "BOOKING" : "UNBOOKED_DEFAULT",
          },
          isDemo: mission.isDemo,
        },
        tx,
      );

      return session;
    });

    return { ok: true, session: toContractSession(opened) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // Someone else holds it. The sweep above cleared anything expired or our own,
    // so the only row that can still be in the way belongs to another user.
    return {
      ok: false,
      status: 409,
      code: "SESSION_NOT_OWNER",
      message: "Another session already owns this mission.",
    };
  }
}

type StartableMission = {
  id: string;
  userId: string;
  observatoryId: string;
  mode: string;
  isDemo: boolean;
  observatory: { latitude: number; longitude: number; mode: string };
  target: Parameters<typeof equatorialFor>[0] & {
    id: string;
    opticalConfig: string;
    imagingProfile: string;
  };
  booking: { slotStartAt: Date; durationMinutes: number; targetId: string } | null;
};

/**
 * Start a scheduled mission: ADR-018.
 *
 * The caller has already checked ownership, the link, the weather hold and that
 * the slot has not ended. This adds the slot's start, the envelope and the cloud's
 * pointing pre-check, and then does four things in one transaction: moves the
 * mission to PREPARING, opens the session, mints the GOTO for the booked target,
 * and records it. The agent is told about the session before the command, so the
 * owner the GOTO names is the owner it already holds.
 *
 * Every refusal writes nothing, so the customer may try again inside the slot.
 */
async function startScheduledMission(input: {
  mission: StartableMission;
  actorId: string;
  now: Date;
  expiresAt: Date;
}): Promise<SessionResult> {
  const { mission, actorId, now, expiresAt } = input;
  const booking = mission.booking;

  if (!booking) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: "A scheduled mission with no booking has no slot to start in.",
    };
  }
  // No early start. The slot before belongs to somebody else until it ends.
  if (now < booking.slotStartAt) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: "The booked slot has not started yet.",
    };
  }
  if (booking.targetId !== mission.target.id) {
    return {
      ok: false,
      status: 409,
      code: "INTERNAL",
      message: "The mission's target and its booking disagree.",
    };
  }

  const site = siteOf(mission.observatory);
  const config = await loadSafetyEnvelope(mission.observatoryId);
  if (!isMeasured(config)) {
    return {
      ok: false,
      status: 409,
      code: "SAFETY_NOT_CONFIGURED",
      message: "MAX_ALT_SAFE is unmeasured, so nothing may slew.",
    };
  }

  const coordinates = equatorialFor(mission.target, now, site);
  const horizontal = horizontalAirlessOf(coordinates, now, site);
  const verdict = evaluatePointing({
    config,
    site,
    at: now,
    altitudeDegrees: horizontal.altitudeDegrees,
    azimuthDegrees: horizontal.azimuthDegrees,
  });
  if (!verdict.permitted) {
    return { ok: false, status: 409, code: "SAFETY_REFUSED", message: verdict.detail };
  }

  const goto: GotoPayload = {
    kind: "GOTO",
    targetId: mission.target.id,
    coordinates,
    opticalConfig: mission.target.opticalConfig as GotoPayload["opticalConfig"],
    imagingProfile: mission.target.imagingProfile as GotoPayload["imagingProfile"],
    recenter: false,
  };

  const database = getDatabase();

  try {
    const opened = await database.$transaction(async (tx) => {
      // Conditional, so two starts cannot both win: the second finds the mission
      // no longer SCHEDULED and writes nothing. Mission_active_per_observatory_unique
      // refuses this update outright if another mission is live here.
      const moved = await tx.mission.updateMany({
        where: { id: mission.id, state: "SCHEDULED" },
        data: { state: "PREPARING", startedAt: now },
      });
      if (moved.count !== 1) return null;

      await tx.missionEvent.create({
        data: {
          missionId: mission.id,
          state: "PREPARING",
          source: "CLOUD",
          message: "Started by the customer inside the booked slot.",
          occurredAt: now,
          simulated: mission.mode === "SIMULATED",
          isDemo: mission.isDemo,
        },
      });

      const session = await tx.missionSession.create({
        data: {
          missionId: mission.id,
          userId: actorId,
          issuedAt: now,
          expiresAt,
          isDemo: mission.isDemo,
        },
      });

      await notifyAgent(tx, {
        kind: "SESSION",
        observatoryId: mission.observatoryId,
        missionId: mission.id,
        sessionId: session.id,
      });

      const commandId = randomUUID();
      const commandExpiresAt = new Date(now.getTime() + COMMAND_TTL_SECONDS * 1000);

      await tx.observatoryCommand.create({
        data: {
          id: commandId,
          missionId: mission.id,
          sessionId: session.id,
          userId: actorId,
          observatoryId: mission.observatoryId,
          type: "GOTO",
          status: "RECEIVED",
          issuedAt: now,
          expiresAt: commandExpiresAt,
          payload: goto as object,
          simulated: mission.observatory.mode === "SIMULATED",
          isDemo: mission.isDemo,
        },
      });

      await notifyAgent(tx, {
        kind: "COMMAND",
        commandId,
        observatoryId: mission.observatoryId,
      });

      await recordAuditEvent(
        {
          category: "MISSION",
          action: "MISSION_SESSION_OPENED",
          actorUserId: actorId,
          missionId: mission.id,
          entityType: "MissionSession",
          entityId: session.id,
          detail: {
            actorRole: "USER",
            expiresAt: expiresAt.toISOString(),
            bounded: "BOOKING",
          },
          isDemo: mission.isDemo,
        },
        tx,
      );

      await recordAuditEvent(
        {
          category: "MISSION",
          action: "MISSION_STARTED",
          actorUserId: actorId,
          missionId: mission.id,
          commandId,
          entityType: "Mission",
          entityId: mission.id,
          detail: {
            sessionId: session.id,
            slotStartAt: booking.slotStartAt.toISOString(),
            coordinates,
          },
          isDemo: mission.isDemo,
        },
        tx,
      );

      return session;
    });

    if (!opened) {
      return {
        ok: false,
        status: 409,
        code: "MISSION_NOT_ACTIVE",
        message: "This mission has already been started.",
      };
    }
    return { ok: true, session: toContractSession(opened) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Another mission is live at this observatory.",
    };
  }
}

/**
 * End a session and tell the agent there is no owner.
 *
 * A null sessionId in CloudSessionUpdate is the revoke: the agent then accepts no
 * client-originated command for the mission at all. Criterion 5's second half.
 */
export async function revokeMissionSession(input: {
  missionId: string;
  reason: string;
  now: Date;
}): Promise<{ revoked: boolean }> {
  const database = getDatabase();

  return database.$transaction(async (tx) => {
    const mission = await tx.mission.findUnique({
      where: { id: input.missionId },
      select: { observatoryId: true },
    });
    if (!mission) return { revoked: false };

    const { count } = await tx.missionSession.updateMany({
      where: { missionId: input.missionId, revokedAt: null },
      data: { revokedAt: input.now, revokedFor: input.reason },
    });

    // Written even when nothing was revoked, and `revokedCount` says which it
    // was. The agent is told either way -- that is the point of the message
    // below -- and the trail records what the cloud declared, not only what it
    // found.
    await recordAuditEvent(
      {
        category: "MISSION",
        action: "MISSION_SESSION_REVOKED",
        missionId: input.missionId,
        entityType: "Mission",
        entityId: input.missionId,
        detail: { reason: input.reason, revokedCount: count },
      },
      tx,
    );

    // Told even when nothing was revoked. The agent's view is what matters, and
    // an agent that believes in a session the cloud has forgotten is the exact
    // state this message exists to prevent.
    await notifyAgent(tx, {
      kind: "SESSION",
      observatoryId: mission.observatoryId,
      missionId: input.missionId,
      sessionId: null,
    });

    return { revoked: count > 0 };
  });
}

/** The session that currently owns this mission, or null. */
export async function currentSession(missionId: string, now: Date) {
  return getDatabase().missionSession.findFirst({
    where: { missionId, revokedAt: null, expiresAt: { gt: now } },
  });
}

/**
 * When the session ends.
 *
 * The end of the booked slot, because that is what the customer bought. Without a
 * booking -- an operator or demo mission -- a fixed window instead.
 */
function sessionExpiry(
  booking: { slotStartAt: Date; durationMinutes: number } | null,
  now: Date,
): Date {
  if (!booking) return new Date(now.getTime() + UNBOOKED_SESSION_MINUTES * 60_000);
  return new Date(booking.slotStartAt.getTime() + booking.durationMinutes * 60_000);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
