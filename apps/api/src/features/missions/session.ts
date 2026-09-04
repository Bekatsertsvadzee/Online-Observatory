import "server-only";

import type { ErrorCode, MissionSession } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { notifyAgent } from "@/lib/observatory/relay";

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
      booking: { select: { slotStartAt: true, durationMinutes: true } },
    },
  });

  // Existence is private: a stranger probing mission ids learns nothing from a
  // 403 that they would not learn from a 404, so they get the 404.
  if (!mission || (actor.role !== "OPERATOR" && mission.userId !== actor.id)) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such mission." };
  }

  if (
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
