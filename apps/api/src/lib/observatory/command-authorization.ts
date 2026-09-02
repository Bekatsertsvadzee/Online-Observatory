import "server-only";

import type { AuthenticatedUser } from "@/lib/auth/types";

export const telescopeCommandCategories = ["MISSION", "ADMINISTRATIVE"] as const;
export type TelescopeCommandCategory = (typeof telescopeCommandCategories)[number];

export type TelescopeCommandAuthorizationContext = {
  actor: AuthenticatedUser | null;
  mission: {
    id: string;
    ownerId: string;
    sessionActive: boolean;
    state: string;
  } | null;
  lease: {
    missionId: string;
    userId: string;
    expiresAt: Date;
    revokedAt: Date | null;
  } | null;
  command: {
    category: TelescopeCommandCategory;
    expiresAt: Date;
  };
  observatoryReady: boolean;
  safetyApproved: boolean;
  now: Date;
};

export type TelescopeCommandDenial =
  | "UNAUTHENTICATED"
  | "ROLE_FORBIDDEN"
  | "NO_ACTIVE_MISSION"
  | "INVALID_LEASE"
  | "COMMAND_EXPIRED"
  | "OBSERVATORY_NOT_READY"
  | "SAFETY_REJECTED";

export type TelescopeCommandAuthorization =
  { authorized: true } | { authorized: false; reason: TelescopeCommandDenial };

const activeMissionStates = new Set([
  "PREPARING",
  "SLEWING",
  "VERIFYING",
  "CENTERING",
  "OBSERVING",
  "CAPTURING",
]);

export function authorizeTelescopeCommand(
  context: TelescopeCommandAuthorizationContext,
): TelescopeCommandAuthorization {
  const { actor, command, lease, mission, now } = context;

  if (!actor) return { authorized: false, reason: "UNAUTHENTICATED" };
  if (command.category === "ADMINISTRATIVE" && actor.role === "USER") {
    return { authorized: false, reason: "ROLE_FORBIDDEN" };
  }
  if (
    !mission ||
    !mission.sessionActive ||
    !activeMissionStates.has(mission.state) ||
    (actor.role === "USER" && mission.ownerId !== actor.id)
  ) {
    return { authorized: false, reason: "NO_ACTIVE_MISSION" };
  }
  if (
    !lease ||
    lease.revokedAt ||
    lease.expiresAt <= now ||
    lease.missionId !== mission.id ||
    lease.userId !== actor.id
  ) {
    return { authorized: false, reason: "INVALID_LEASE" };
  }
  if (command.expiresAt <= now) {
    return { authorized: false, reason: "COMMAND_EXPIRED" };
  }
  if (!context.observatoryReady) {
    return { authorized: false, reason: "OBSERVATORY_NOT_READY" };
  }
  if (!context.safetyApproved) {
    return { authorized: false, reason: "SAFETY_REJECTED" };
  }
  return { authorized: true };
}
