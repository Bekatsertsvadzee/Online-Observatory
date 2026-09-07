import "server-only";

import type {
  ErrorCode,
  MissionObserver,
  MissionObserverList,
} from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { getDatabase } from "@/lib/db/client";
import { LIVE_MISSION_STATES } from "@/features/missions/session";

/**
 * Observer seats: a paid, view-only place on a session somebody else controls.
 *
 * ADR-007 fixes the rules this file implements, and the most important one is not
 * here at all. "Observers never command" is structural rather than a check below:
 * the cloud mints a CommandEnvelope only for the session owner, and the agent
 * independently refuses any envelope whose `sessionId` is not the owner it last
 * received. An observer has no path to the mount even if everything in this file
 * is wrong. Nothing here may ever be asked to grant command capability.
 *
 * Observers also receive no captures. `canSaveCaptures` stays false and
 * `CaptureAccess` stays frozen by ADR-003, which ADR-007 left frozen on purpose:
 * keeping an image requires booking a session.
 */

export type ObserverFailure = {
  ok: false;
  status: 402 | 403 | 404 | 409;
  code: ErrorCode;
  message: string;
};

export type ObserverResult<T> = { ok: true; value: T } | ObserverFailure;

/**
 * ADR-007's hard cap, here only so a test can assert the two agree. What actually
 * stops a sixth seat is Mission_observer_capacity_within_adr007 in the migration.
 */
export const MAX_OBSERVER_CAPACITY = 5;

const NO_SUCH_MISSION: ObserverFailure = {
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: "No such mission.",
};

function toContractObserver(row: {
  id: string;
  missionId: string;
  userId: string;
  joinedAt: Date;
  leftAt: Date | null;
}): MissionObserver {
  return {
    id: row.id,
    missionId: row.missionId,
    userId: row.userId,
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt?.toISOString() ?? null,
  };
}

/**
 * Who is watching.
 *
 * The contract: "Visible to the session owner and to operators. Observers see
 * only the count." An observer therefore gets an empty `items` with the real
 * capacity -- not a 403, because they are entitled to know how full the session
 * is, and not the list, because who else is watching is not theirs to know.
 */
export async function listMissionObservers(input: {
  missionId: string;
  actor: { id: string; role: "USER" | "OPERATOR" };
}): Promise<ObserverResult<MissionObserverList>> {
  const database = getDatabase();
  const { missionId, actor } = input;

  const mission = await database.mission.findUnique({
    where: { id: missionId },
    select: { userId: true, observerCapacity: true },
  });
  if (!mission) return NO_SUCH_MISSION;

  const seats = await database.missionParticipant.findMany({
    where: { missionId, status: "JOINED" },
    orderBy: { joinedAt: "asc" },
  });

  const entitled = actor.role === "OPERATOR" || mission.userId === actor.id;
  const watching = seats.some((seat) => seat.userId === actor.id);

  // Not the owner, not an operator, not watching: this mission is not theirs to
  // ask about, and the 404 says no more than that.
  if (!entitled && !watching) return NO_SUCH_MISSION;

  return {
    ok: true,
    value: {
      items: entitled ? seats.map(toContractObserver) : [],
      capacity: mission.observerCapacity,
    },
  };
}

/**
 * Take a seat.
 *
 * The capacity check and the insert are one transaction over a locked mission
 * row. Counting and then inserting without the lock cannot be correct: two
 * requests arriving together both count four seats taken and both insert a
 * fifth, which is how a hard cap of five becomes six. Same reasoning as DV-055's
 * held-slot index and DV-058's active-owner index; the difference is that "at
 * most N rows" is not something a unique index can say, so the lock says it.
 *
 * The payment this seat requires is deliberately not checked here. DV-102 owns
 * it, and until then the route refuses before reaching this function.
 */
export async function takeObserverSeat(input: {
  missionId: string;
  userId: string;
  now: Date;
}): Promise<ObserverResult<MissionObserver>> {
  const database = getDatabase();
  const { missionId, userId, now } = input;

  try {
    return await database.$transaction(async (tx) => {
      // FOR UPDATE, so concurrent joins on one mission queue behind each other.
      const rows = await tx.$queryRaw<
        {
          userId: string;
          state: string;
          joinPolicy: string;
          observerCapacity: number;
          isDemo: boolean;
        }[]
      >`
        SELECT "userId", "state"::text AS state, "joinPolicy"::text AS "joinPolicy",
               "observerCapacity", "isDemo"
        FROM "Mission" WHERE "id" = ${missionId}::uuid FOR UPDATE
      `;

      const mission = rows[0];
      if (!mission) return NO_SUCH_MISSION;

      // The controller is not an observer of their own session. They hold it
      // already, and a seat would take one from somebody who could have watched.
      if (mission.userId === userId) {
        return {
          ok: false,
          status: 409,
          code: "CONFLICT",
          message: "The controller of a session cannot also observe it.",
        } satisfies ObserverFailure;
      }

      if (
        !LIVE_MISSION_STATES.includes(
          mission.state as (typeof LIVE_MISSION_STATES)[number],
        )
      ) {
        return {
          ok: false,
          status: 409,
          code: "MISSION_NOT_ACTIVE",
          message: `A mission in ${mission.state} has nothing to observe.`,
        } satisfies ObserverFailure;
      }

      // ADR-007 rule 5: private by default, observable only when the controller
      // opts in. DV-101 is the endpoint that opts in.
      if (mission.joinPolicy !== "OPEN") {
        return {
          ok: false,
          status: 403,
          code: "MISSION_NOT_OBSERVABLE",
          message: "The controller has not opened this session to observers.",
        } satisfies ObserverFailure;
      }

      const existing = await tx.missionParticipant.findUnique({
        where: { missionId_userId: { missionId, userId } },
      });

      // Rejoining is the same seat, not a second one -- which is what a
      // reconnecting client needs, and what the unique index would otherwise
      // turn into an error.
      if (existing?.status === "JOINED") {
        return { ok: true, value: toContractObserver(existing) };
      }

      const taken = await tx.missionParticipant.count({
        where: { missionId, status: "JOINED" },
      });
      if (taken >= mission.observerCapacity) {
        return {
          ok: false,
          status: 409,
          code: "OBSERVER_CAPACITY_REACHED",
          message: `All ${mission.observerCapacity} observer seats are taken.`,
        } satisfies ObserverFailure;
      }

      const seat = existing
        ? await tx.missionParticipant.update({
            where: { id: existing.id },
            data: { status: "JOINED", joinedAt: now, leftAt: null },
          })
        : await tx.missionParticipant.create({
            data: {
              missionId,
              userId,
              status: "JOINED",
              joinedAt: now,
              // ADR-007: observers receive no captures. Stated rather than left
              // to the column default, because this is a rule and not a default.
              canSaveCaptures: false,
              isDemo: mission.isDemo,
            },
          });

      await recordAuditEvent(
        {
          category: "MISSION",
          action: "OBSERVER_SEAT_TAKEN",
          actorUserId: userId,
          missionId,
          entityType: "MissionParticipant",
          entityId: seat.id,
          detail: { seatsTaken: taken + 1, capacity: mission.observerCapacity },
          isDemo: mission.isDemo,
        },
        tx,
      );

      return { ok: true, value: toContractObserver(seat) };
    });
  } catch (error) {
    // The unique index on (missionId, userId) backstops two joins by the same
    // person racing past the read above.
    if (!isUniqueViolation(error)) throw error;
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "That seat is already taken.",
    };
  }
}

/** Give the seat back. Idempotent: leaving twice is not an error. */
export async function releaseObserverSeat(input: {
  missionId: string;
  userId: string;
  now: Date;
}): Promise<ObserverResult<null>> {
  const database = getDatabase();
  const { missionId, userId, now } = input;

  return database.$transaction(async (tx) => {
    const { count } = await tx.missionParticipant.updateMany({
      where: { missionId, userId, status: "JOINED" },
      data: { status: "LEFT", leftAt: now },
    });

    if (count > 0) {
      await recordAuditEvent(
        {
          category: "MISSION",
          action: "OBSERVER_SEAT_RELEASED",
          actorUserId: userId,
          missionId,
          entityType: "Mission",
          entityId: missionId,
        },
        tx,
      );
    }

    return { ok: true, value: null };
  });
}

/**
 * Close a session to observers, detaching everyone watching.
 *
 * The contract's own words on `setMissionObservation`: "Closing a session
 * detaches any attached observers." Consent withdrawn has to mean the watching
 * stops now, not that it stops for the next person who asks.
 */
export async function detachAllObservers(input: {
  missionId: string;
  now: Date;
}): Promise<number> {
  const { count } = await getDatabase().missionParticipant.updateMany({
    where: { missionId: input.missionId, status: "JOINED" },
    data: { status: "LEFT", leftAt: input.now },
  });
  return count;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}
