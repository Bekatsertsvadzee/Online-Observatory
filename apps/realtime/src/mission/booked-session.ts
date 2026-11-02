import type { ImageHealth, MissionTelemetryUpdate } from "@darkview/contracts";
import {
  CAPTURE_COOLDOWN_SECONDS,
  MAX_CAPTURES_PER_MISSION,
  dwellEndsAt,
} from "@darkview/db/booked-session";

import {
  LIVE_MISSION_STATES,
  TERMINAL_MISSION_STATES,
  type MissionLiveContext,
} from "@/link/store";

export type BookedSessionTelemetry = Pick<
  MissionTelemetryUpdate,
  "currentTargetId" | "retargetAllowedAt" | "captureAllowedAt" | "imageHealth" | "endPhase"
>;

/**
 * What a booked session adds to MISSION_TELEMETRY (ADR-079, ADR-080).
 *
 * Arithmetic on facts the cloud already holds -- the dwell, the cooldown and the end
 * phase are counts of seconds from rows it wrote -- and the agent's own picture
 * verdict, relayed unchanged. The rules that refuse a command are the API's; these
 * are the same numbers, so a client's countdown ends when the refusal does.
 *
 * Not applied here: the dwell waiver for an object that has left the visible-now
 * list. Judging that needs the ephemeris, which lives in the API, and the client
 * reads it from `GET /missions/{missionId}/targets`, whose `retargetAllowedAt` has
 * every waiver applied.
 */
export function bookedSessionTelemetry(
  context: MissionLiveContext | null,
  input: { imageHealth: ImageHealth | null; parked: boolean; now: Date },
): BookedSessionTelemetry {
  const { now } = input;
  if (!context) {
    return {
      currentTargetId: null,
      retargetAllowedAt: null,
      captureAllowedAt: null,
      imageHealth: input.imageHealth,
      endPhase: null,
    };
  }

  const live = (LIVE_MISSION_STATES as readonly string[]).includes(context.state);
  const terminal = (TERMINAL_MISSION_STATES as readonly string[]).includes(context.state);

  const dwell = dwellEndsAt(context.currentTargetSince);
  const unrecovered = input.imageHealth?.status === "UNRECOVERED";
  const retargetAllowedAt =
    live && dwell && dwell > now && !unrecovered ? dwell.toISOString() : null;

  const capturing =
    context.captureAwaitingVerdict ||
    context.state === "CAPTURING" ||
    context.state === "PROCESSING";
  const cooldown = context.lastCaptureIssuedAt
    ? new Date(context.lastCaptureIssuedAt.getTime() + CAPTURE_COOLDOWN_SECONDS * 1000)
    : null;
  const captureAllowedAt =
    live && !capturing && context.captureCount < MAX_CAPTURES_PER_MISSION && cooldown && cooldown > now
      ? cooldown.toISOString()
      : null;

  let endPhase: BookedSessionTelemetry["endPhase"] = null;
  if (terminal) endPhase = input.parked ? "PARKED" : "PARKING";
  else if (live && context.sessionEndsAt && context.sessionEndsAt <= now) endPhase = "FINISHING";

  return {
    currentTargetId: context.currentTargetId,
    retargetAllowedAt,
    captureAllowedAt,
    // Relayed unchanged: the agent sends it only while OBSERVING.
    imageHealth: input.imageHealth,
    endPhase,
  };
}
