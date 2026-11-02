import "server-only";

import type { ErrorCode, MissionTargetList } from "@darkview/contracts";
import type { Target } from "@darkview/db";
import { dwellEndsAt } from "@darkview/db/booked-session";

import { effectiveRetargetAllowedAt } from "@/features/missions/in-slot";
import {
  LIVE_MISSION_STATES,
  currentSession,
  sessionEndsAtOf,
} from "@/features/missions/session";
import { toContractTarget, type TargetRow } from "@/features/targets/projection";
import { getDatabase } from "@/lib/db/client";
import { evaluateVisibleNow, type VisibleNow } from "@/lib/ephemeris/visible-now";
import { loadSafetyEnvelope, siteOf } from "@/lib/safety/store";

/**
 * The catalogue judged across a live mission's dwell window (ADR-079).
 *
 * The one place the visible-now list is built, so `GET /missions/{missionId}/targets`
 * and the RETARGET refusal cannot disagree about what the customer may switch to.
 * Enabled targets only, as the booking's "Best in the sky" reads them.
 */
export async function visibleNowFor(input: {
  observatory: {
    id: string;
    latitude: number;
    longitude: number;
    status: string;
    weatherState: { holdActive: boolean } | null;
  };
  currentTargetId: string | null;
  sessionEndsAt: Date;
  now: Date;
}): Promise<VisibleNow<Target>> {
  const { observatory, now } = input;
  const [envelope, targets] = await Promise.all([
    loadSafetyEnvelope(observatory.id),
    getDatabase().target.findMany({ where: { enabled: true }, orderBy: { slug: "asc" } }),
  ]);

  return evaluateVisibleNow({
    targets,
    site: siteOf(observatory),
    // Admitted for the observatory's mode (ADR-032), as the mission start loads it.
    envelope,
    observatory: {
      online: observatory.status === "ONLINE",
      weatherHold: observatory.weatherState?.holdActive ?? false,
    },
    now,
    sessionEndsAt: input.sessionEndsAt,
    currentTargetId: input.currentTargetId,
  });
}

export type MissionTargetsResult =
  | { ok: true; list: MissionTargetList }
  | { ok: false; status: 404 | 409; code: ErrorCode; message: string };

/**
 * GET /missions/{missionId}/targets: what the session owner may switch to now.
 *
 * Owner only, as `GET /missions/{missionId}`: anyone else is told the mission does
 * not exist. Computed at request time and never cached -- the sky moves.
 */
export async function listMissionTargets(input: {
  missionId: string;
  userId: string;
  now: Date;
}): Promise<MissionTargetsResult> {
  const { missionId, userId, now } = input;

  const mission = await getDatabase().mission.findFirst({
    where: { id: missionId, userId },
    include: {
      observatory: { include: { weatherState: { select: { holdActive: true } } } },
      booking: { select: { slotStartAt: true, durationMinutes: true } },
    },
  });
  if (!mission) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such mission." };
  }
  if (!(LIVE_MISSION_STATES as readonly string[]).includes(mission.state)) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: `A mission in ${mission.state} has no live session to switch objects in.`,
    };
  }

  const sessionEndsAt = sessionEndsAtOf(
    mission.booking,
    await currentSession(missionId, now),
  );
  if (!sessionEndsAt) {
    return {
      ok: false,
      status: 409,
      code: "MISSION_NOT_ACTIVE",
      message: "No session owns this mission. Start one first.",
    };
  }

  const currentTargetId = mission.currentTargetId ?? mission.targetId;
  const visible = await visibleNowFor({
    observatory: mission.observatory,
    currentTargetId,
    sessionEndsAt,
    now,
  });

  const retargetAllowedAt = effectiveRetargetAllowedAt({
    dwellEndsAt: dwellEndsAt(mission.currentTargetSince),
    unrecovered: mission.imageUnrecoveredSince !== null,
    currentListed: visible.items.some((item) => item.current),
    now,
  });

  return {
    ok: true,
    list: {
      missionId: mission.id,
      observatoryId: mission.observatoryId,
      evaluatedAt: visible.evaluatedAt.toISOString(),
      windowEndsAt: visible.windowEndsAt.toISOString(),
      sessionEndsAt: sessionEndsAt.toISOString(),
      currentTargetId,
      retargetAllowedAt: retargetAllowedAt?.toISOString() ?? null,
      items: visible.items.map((item) => ({
        target: toContractTarget(item.target as unknown as TargetRow),
        visibility: item.visibility,
        observableUntil: item.observableUntil.toISOString(),
        current: item.current,
      })),
    },
  };
}
