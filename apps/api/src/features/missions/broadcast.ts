import "server-only";

import type { Mission, Tonight } from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import type { ObserverResult } from "@/features/missions/observers";
import { readContractMission } from "@/features/missions/observers";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { getDatabase } from "@/lib/db/client";

/**
 * Clients ADR-066: Tonight, live. The owner opens a session to anyone, and anyone may
 * watch it at the spectator rate. Separate from the paid observer seats (ADR-007,
 * ADR-036), which this neither grants nor touches.
 */

/** ADR-066 §4. The realtime service enforces it; this is what `GET /tonight` states. */
export const SPECTATOR_CAPACITY = 20;

/** A session can be opened before it starts, so the owner may open it from the room. */
const OPENABLE_STATES = ["SCHEDULED", ...LIVE_MISSION_STATES] as const;

/**
 * The owner opens or closes their session. Anyone else, operators included, gets the
 * same 404 as a mission that does not exist: the consent is the owner's to give.
 * Closing is always accepted, whatever the state, so a session can never be stuck open.
 */
export async function setMissionBroadcast(input: {
  missionId: string;
  userId: string;
  broadcast: boolean;
}): Promise<ObserverResult<Mission>> {
  const database = getDatabase();
  const { missionId, userId, broadcast } = input;

  const mission = await database.mission.findUnique({
    where: { id: missionId },
    select: { userId: true, state: true, isDemo: true, broadcast: true },
  });
  if (!mission || mission.userId !== userId) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such mission." };
  }
  if (
    broadcast &&
    !OPENABLE_STATES.includes(mission.state as (typeof OPENABLE_STATES)[number])
  ) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: `A mission in ${mission.state} cannot be opened to Tonight, live.`,
    };
  }

  return database.$transaction(async (tx) => {
    if (mission.broadcast !== broadcast) {
      await tx.mission.update({ where: { id: missionId }, data: { broadcast } });
      await recordAuditEvent(
        {
          category: "MISSION",
          action: broadcast ? "MISSION_OPENED_TO_TONIGHT" : "MISSION_CLOSED_TO_TONIGHT",
          actorUserId: userId,
          missionId,
          entityType: "Mission",
          entityId: missionId,
          isDemo: mission.isDemo,
        },
        tx,
      );
    }
    return { ok: true, value: await readContractMission(tx, missionId) };
  });
}

/**
 * The one session open to anyone now: live, opened by its owner, the most recently
 * started when more than one is. The owner and everyone watching stay unnamed.
 */
export async function readTonight(): Promise<Tonight> {
  const row = await getDatabase().mission.findFirst({
    where: { broadcast: true, state: { in: [...LIVE_MISSION_STATES] } },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      observatoryId: true,
      state: true,
      mode: true,
      target: { select: { slug: true, nameEn: true, nameKa: true, type: true } },
      booking: { select: { slotStartAt: true, durationMinutes: true } },
    },
  });
  if (!row) return { live: null };

  const endsAt = row.booking
    ? new Date(row.booking.slotStartAt.getTime() + row.booking.durationMinutes * 60_000)
    : null;

  return {
    live: {
      missionId: row.id,
      observatoryId: row.observatoryId,
      target: row.target,
      state: row.state,
      mode: row.mode,
      endsAt: endsAt?.toISOString() ?? null,
      spectatorCapacity: SPECTATOR_CAPACITY,
      streamPath: `/stream/mission/${row.id}/spectate`,
    },
  };
}
