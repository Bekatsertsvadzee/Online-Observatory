import "server-only";

import type { ErrorCode, OperatorObservatoryState } from "@darkview/contracts";
import { zObservatoryTelemetrySnapshot } from "@darkview/contracts/zod";

import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { getDatabase } from "@/lib/db/client";
import { loadSafetyEnvelope } from "@/lib/safety/store";

/** How long the operator console waits for the realtime service (ADR-017 §3). */
export const REALTIME_TIMEOUT_MS = 2_000;

export type ObservatoryStateFailure = {
  ok: false;
  status: 404 | 503;
  code: ErrorCode;
  message: string;
};

const offline: ObservatoryStateFailure = {
  ok: false,
  status: 503,
  code: "OBSERVATORY_OFFLINE",
  message:
    "No live telemetry: the agent is not connected, or the realtime service cannot be reached.",
};

/**
 * `OperatorObservatoryState`, assembled from the two places that know it.
 *
 * Telemetry and the last heartbeat come from the realtime service, the only
 * process holding the agent link. The envelope and the live mission and session
 * come from the database. Nothing is filled in when the realtime answer is
 * missing: an operator console showing devices as DISCONNECTED would describe
 * equipment the cloud cannot see (ADR-017 §4).
 *
 * The snapshot is parsed with the generated schema before it is trusted, and must
 * be for the observatory that was asked about.
 */
export async function readOperatorObservatoryState(input: {
  observatoryId: string;
  realtime: { url?: string; secret?: string };
  now: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; state: OperatorObservatoryState } | ObservatoryStateFailure> {
  const { observatoryId, realtime, now } = input;
  const fetchImpl = input.fetchImpl ?? fetch;

  const safetyEnvelope = await loadSafetyEnvelope(observatoryId);
  if (!safetyEnvelope) {
    return {
      ok: false,
      status: 503,
      code: "SAFETY_NOT_CONFIGURED",
      message: "No safety envelope has been recorded for this observatory.",
    };
  }

  if (!realtime.url || !realtime.secret) return offline;

  let snapshot;
  try {
    const response = await fetchImpl(
      new URL(`/internal/observatories/${observatoryId}/state`, realtime.url),
      {
        headers: { authorization: `Bearer ${realtime.secret}` },
        cache: "no-store",
        signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
      },
    );
    if (!response.ok) return offline;

    const parsed = zObservatoryTelemetrySnapshot.safeParse(await response.json());
    if (!parsed.success || parsed.data.observatoryId !== observatoryId) return offline;
    snapshot = parsed.data;
  } catch {
    return offline;
  }

  const database = getDatabase();
  const live = await database.mission.findFirst({
    where: { observatoryId, state: { in: [...LIVE_MISSION_STATES] } },
    select: { id: true },
  });
  const session = live
    ? await database.missionSession.findFirst({
        where: { missionId: live.id, revokedAt: null, expiresAt: { gt: now } },
        select: { id: true },
      })
    : null;

  return {
    ok: true,
    state: {
      observatoryId,
      telemetry: snapshot.telemetry,
      safetyEnvelope,
      activeMissionId: live?.id ?? null,
      activeSessionId: session?.id ?? null,
      // Nothing measures a round trip, and a guess is not a latency.
      linkLatencyMs: null,
      lastHeartbeatAt: snapshot.lastHeartbeatAt,
      updatedAt: snapshot.telemetry.reportedAt,
    },
  };
}
