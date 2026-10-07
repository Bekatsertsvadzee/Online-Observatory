import "server-only";

import type { MissionWatchView } from "@darkview/contracts";

import { toContractPack } from "@/features/missions/observer-pack";
import { readContractMission } from "@/features/missions/observers";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { toContractTarget, type TargetRow } from "@/features/targets/projection";
import { getDatabase } from "@/lib/db/client";

/**
 * Who may read a mission's watch view (ADR-034).
 *
 * The owner, always. Somebody holding an attached seat, always -- they paid for
 * it. Anyone else signed in only while the owner has opened the session to
 * observers and it is live: that is ADR-007's consent, and a stranger needs the
 * view to decide whether to buy a seat. And a buyer holding a PAID pack, in any
 * state (ADR-045): once the owner closes, their seat is LEFT and the session no
 * longer open, yet what they paid and what the close gave back must stay readable. `joinPolicy` is the consent; the legacy
 * `sharingMode` column is not consulted, because no operation sets it and a
 * session must never become visible by a value its owner never chose.
 */
export function mayWatch(input: {
  actorId: string;
  ownerId: string;
  seated: boolean;
  /** The caller holds a PAID Observer Pack on this mission (ADR-045). */
  paid: boolean;
  joinPolicy: string;
  state: string;
}): boolean {
  if (input.actorId === input.ownerId) return true;
  if (input.seated) return true;
  if (input.paid) return true;
  return (
    input.joinPolicy === "OPEN" &&
    LIVE_MISSION_STATES.includes(input.state as (typeof LIVE_MISSION_STATES)[number])
  );
}

/**
 * The watch view, or null for anybody not allowed it -- the same null as for a
 * mission that does not exist, so a stranger learns nothing by probing ids.
 *
 * It carries no captures. ADR-007 stands: nothing from this mission enters an
 * observer's Collection, so there is nothing here for one to save.
 */
export async function getMissionWatchView(input: {
  missionId: string;
  actorId: string;
}): Promise<MissionWatchView | null> {
  const database = getDatabase();
  const { missionId, actorId } = input;

  const row = await database.mission.findUnique({
    where: { id: missionId },
    select: {
      userId: true,
      state: true,
      joinPolicy: true,
      user: { select: { name: true, deletedAt: true } },
      target: true,
      telescope: {
        select: {
          manufacturer: true,
          model: true,
          apertureMm: true,
          focalLengthMm: true,
        },
      },
      observatory: {
        select: {
          id: true,
          slug: true,
          nameEn: true,
          nameKa: true,
          city: true,
          countryCode: true,
          timezone: true,
          networkNode: { select: { kind: true } },
        },
      },
      participants: {
        where: { userId: actorId, status: "JOINED" },
        select: { id: true, missionId: true, userId: true, joinedAt: true, leftAt: true },
        take: 1,
      },
      // The caller's own pack, whatever its status (ADR-045). One per person per
      // mission, by the unique index.
      observerPacks: { where: { userId: actorId }, take: 1 },
    },
  });
  // ADR-044: a deleted account's observations are no longer shared with anyone.
  if (!row || row.user.deletedAt) return null;

  const seat = row.participants.at(0) ?? null;
  const pack = row.observerPacks.at(0) ?? null;
  if (
    !mayWatch({
      actorId,
      ownerId: row.userId,
      seated: seat !== null,
      paid: pack?.status === "PAID",
      joinPolicy: row.joinPolicy,
      state: row.state,
    })
  ) {
    return null;
  }

  const mission = await readContractMission(database, missionId);
  const { observatory, telescope } = row;

  return {
    mission,
    target: toContractTarget(row.target as unknown as TargetRow),
    observatory: {
      id: observatory.id,
      slug: observatory.slug,
      // An observatory without a network node is one Darkview runs itself: a
      // partner exists only by registering one (ADR-013).
      kind: observatory.networkNode?.kind ?? "FIRST_PARTY",
      nameEn: observatory.nameEn,
      nameKa: observatory.nameKa,
      city: observatory.city,
      countryCode: observatory.countryCode,
      timezone: observatory.timezone,
      // The instrument this mission runs on, which is the one being watched --
      // not whichever telescope the node sells next.
      telescope: {
        manufacturer: telescope.manufacturer,
        model: telescope.model,
        apertureMm: telescope.apertureMm,
        focalLengthMm: telescope.focalLengthMm,
      },
    },
    ownerDisplayName: row.user.name || null,
    observerCount: mission.observerCount ?? 0,
    myObserverSeat: seat
      ? {
          id: seat.id,
          missionId: seat.missionId,
          userId: seat.userId,
          joinedAt: seat.joinedAt.toISOString(),
          leftAt: seat.leftAt?.toISOString() ?? null,
        }
      : null,
    myObserverPack: pack ? toContractPack(pack) : null,
  };
}
