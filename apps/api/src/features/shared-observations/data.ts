import "server-only";

import type { AuthenticatedUser } from "@/lib/auth/types";
import { getDatabase } from "@/lib/db/client";

import {
  authorizeSharedMission,
  canSaveSharedCapture,
  sharedMissionStates,
} from "./domain";

const activePresenceWindowMs = 60_000;

export async function getSharedMissionView(missionId: string, actor: AuthenticatedUser) {
  const database = getDatabase();
  const mission = await database.mission.findUnique({
    where: { id: missionId },
    include: {
      target: true,
      observatory: true,
      telescope: true,
      user: { select: { id: true, name: true } },
      participants: { where: { userId: actor.id }, take: 1 },
      captures: {
        orderBy: { capturedAt: "desc" },
        take: 3,
        include: {
          access: { where: { userId: actor.id }, take: 1 },
          assets: { where: { kind: "THUMBNAIL" }, take: 1 },
        },
      },
    },
  });

  if (!mission) return null;

  const authorization = authorizeSharedMission(actor, {
    id: mission.id,
    ownerId: mission.userId,
    state: mission.state,
    sharingMode: mission.sharingMode,
    joinPolicy: mission.joinPolicy,
    allowSharedCaptures: mission.allowSharedCaptures,
  });

  if (!authorization.canView) return null;

  const viewerCount = await database.missionPresence.count({
    where: {
      missionId,
      leftAt: null,
      lastSeenAt: { gte: new Date(Date.now() - activePresenceWindowMs) },
    },
  });
  const participant = mission.participants.at(0) ?? null;

  return {
    id: mission.id,
    state: mission.state as (typeof sharedMissionStates)[number],
    target: {
      nameEn: mission.target.nameEn,
      nameKa: mission.target.nameKa,
      catalogId: mission.target.catalogId,
    },
    observatory: {
      nameEn: mission.observatory.nameEn,
      nameKa: mission.observatory.nameKa,
    },
    telescope: mission.telescope.name,
    ownerName: mission.user.name,
    initialElapsedSeconds: mission.startedAt
      ? Math.max(0, Math.floor((Date.now() - mission.startedAt.getTime()) / 1000))
      : 0,
    viewerCount,
    participantStatus: participant?.status ?? null,
    canJoin: authorization.canJoin,
    canControl: authorization.canControl,
    allowSharedCaptures: mission.allowSharedCaptures,
    mode: mission.mode,
    captures: mission.captures.map((capture) => ({
      id: capture.id,
      thumbnailStorageKey: capture.assets.at(0)?.storageKey ?? null,
      processingPreset: capture.processingPreset,
      capturedAt: capture.capturedAt.toISOString(),
      canSave: canSaveSharedCapture({
        actorId: actor.id,
        mission: {
          id: mission.id,
          ownerId: mission.userId,
          state: mission.state,
          sharingMode: mission.sharingMode,
          joinPolicy: mission.joinPolicy,
          allowSharedCaptures: mission.allowSharedCaptures,
        },
        capture: { missionId: capture.missionId, ownerId: capture.userId },
        participant,
        access: capture.access.at(0) ?? null,
      }),
    })),
  };
}

export type SharedMissionView = NonNullable<
  Awaited<ReturnType<typeof getSharedMissionView>>
>;
