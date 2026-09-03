import type { AuthenticatedUser } from "@/lib/auth/types";

export const sharedMissionStates = [
  "PREPARING",
  "SLEWING",
  "VERIFYING",
  "CENTERING",
  "OBSERVING",
  "CAPTURING",
  "PROCESSING",
] as const;

type SharedMission = {
  id: string;
  ownerId: string;
  state: string;
  sharingMode: "PRIVATE" | "PUBLIC";
  joinPolicy: "DISABLED" | "OPEN";
  allowSharedCaptures: boolean;
};

type Participant = {
  status: "JOINED" | "LEFT";
  canSaveCaptures: boolean;
} | null;

type CaptureAccess = {
  missionId: string;
  status: "AVAILABLE" | "SAVED" | "REVOKED";
} | null;

export type SharedMissionAuthorization = {
  canView: boolean;
  canJoin: boolean;
  canControl: boolean;
  reason?: "UNAUTHENTICATED" | "MISSION_PRIVATE" | "MISSION_NOT_LIVE";
};

export function authorizeSharedMission(
  actor: AuthenticatedUser | null,
  mission: SharedMission,
): SharedMissionAuthorization {
  if (!actor) {
    return {
      canView: false,
      canJoin: false,
      canControl: false,
      reason: "UNAUTHENTICATED",
    };
  }

  const canControl =
    actor.id === mission.ownerId || actor.role === "OPERATOR";
  const isLive = sharedMissionStates.includes(
    mission.state as (typeof sharedMissionStates)[number],
  );

  if (!isLive) {
    return {
      canView: false,
      canJoin: false,
      canControl,
      reason: "MISSION_NOT_LIVE",
    };
  }

  if (mission.sharingMode !== "PUBLIC" && !canControl) {
    return {
      canView: false,
      canJoin: false,
      canControl: false,
      reason: "MISSION_PRIVATE",
    };
  }

  return {
    canView: true,
    canJoin: mission.joinPolicy === "OPEN" && actor.id !== mission.ownerId && !canControl,
    canControl,
  };
}

export function canSaveSharedCapture(input: {
  actorId: string;
  mission: SharedMission;
  capture: { missionId: string; ownerId: string };
  participant: Participant;
  access: CaptureAccess;
}) {
  return (
    input.capture.ownerId !== input.actorId &&
    input.capture.missionId === input.mission.id &&
    input.mission.allowSharedCaptures &&
    input.participant?.status === "JOINED" &&
    input.participant.canSaveCaptures &&
    input.access?.missionId === input.mission.id &&
    input.access.status === "AVAILABLE"
  );
}
