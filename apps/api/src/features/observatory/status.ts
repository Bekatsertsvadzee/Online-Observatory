import "server-only";

import type { PublicObservatoryStatus } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { LIVE_MISSION_STATES } from "@/features/missions/session";

/**
 * What a public page may know about one observatory.
 *
 * Built only from what is stored, so every field is something the cloud actually
 * knows rather than something it assumes:
 *
 * - `link` is ONLINE or OFFLINE, never DEGRADED. The realtime service writes
 *   `Observatory.status` on connect and on loss, and nothing records a late
 *   heartbeat, so reporting DEGRADED would be a guess.
 * - `weather` with no stored row is UNKNOWN, not CLEAR. Phase 1 has no sensor, and
 *   an operator who never set the weather has not said it is fine.
 * - `currentTargetName` is always null. The contract allows it only while the
 *   mission owner has opted in, and no opt-in exists to read.
 */
export async function readPublicObservatoryStatus(
  observatoryId: string,
): Promise<PublicObservatoryStatus | null> {
  const database = getDatabase();

  const observatory = await database.observatory.findUnique({
    where: { id: observatoryId },
    select: {
      id: true,
      mode: true,
      status: true,
      updatedAt: true,
      weatherState: { select: { status: true, holdActive: true, note: true, updatedAt: true } },
    },
  });
  if (!observatory) return null;

  const [live, lastComplete] = await Promise.all([
    database.mission.findFirst({
      where: { observatoryId, state: { in: [...LIVE_MISSION_STATES] } },
      select: { id: true },
    }),
    database.mission.findFirst({
      where: { observatoryId, state: "COMPLETE", completedAt: { not: null } },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    }),
  ]);

  const weather = observatory.weatherState;
  const updatedAt =
    weather && weather.updatedAt > observatory.updatedAt
      ? weather.updatedAt
      : observatory.updatedAt;

  return {
    observatoryId: observatory.id,
    mode: observatory.mode,
    link: observatory.status === "ONLINE" ? "ONLINE" : "OFFLINE",
    weather: {
      status: weather?.status ?? "UNKNOWN",
      // The only writer of weather in Phase 1 is the operator's hold; see
      // setWeatherHold, which asserts the same.
      source: "OPERATOR",
      holdActive: weather?.holdActive ?? false,
      note: weather?.note ?? null,
      updatedAt: (weather?.updatedAt ?? observatory.updatedAt).toISOString(),
    },
    missionInProgress: live !== null,
    currentTargetName: null,
    lastSuccessfulMissionAt: lastComplete?.completedAt?.toISOString() ?? null,
    updatedAt: updatedAt.toISOString(),
  };
}
