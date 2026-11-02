import type {
  MissionFailureReason,
  MissionState,
  SessionEndReason,
} from "@darkview/contracts";

/**
 * ADR-079's numbers, written once.
 *
 * Here for the reason `capture.ts` is: the API refuses a RETARGET or a CAPTURE on
 * them, and the realtime service tells the watching client when the next one will be
 * accepted. Two copies of "600" are how the countdown and the refusal come to
 * disagree. The agent keeps its own copy; it is Python, and ADR-079 names the value.
 */

/** The minimum dwell on one object: a RETARGET is refused until it has passed. */
export const DWELL_SECONDS = 600;

/** The least time between successive CAPTUREs' `issuedAt`. */
export const CAPTURE_COOLDOWN_SECONDS = 30;

/** The most captures one mission may hold. */
export const MAX_CAPTURES_PER_MISSION = 50;

/** No CAPTURE in the last minute of the slot: it could not finish before the park. */
export const CAPTURE_CLOSE_SECONDS = 60;

/** No RETARGET in the last five minutes: the acquisition would eat what is left. */
export const RETARGET_CLOSE_SECONDS = 300;

/** The window a visible-now target must stay up across: the dwell, clamped to the slot. */
export const VISIBLE_NOW_WINDOW_SECONDS = DWELL_SECONDS;

/**
 * How long after a mission ends the cloud waits for the mount to report parked before
 * it sends MISSION_SESSION_ENDED anyway, and keeps sending MISSION_TELEMETRY meanwhile.
 */
export const END_TELEMETRY_SECONDS = 300;

/**
 * When the dwell lock lifts: the moment the agent accepted the GOTO or RETARGET that
 * put the mount on the current object, plus DWELL_SECONDS. Null when nothing is held.
 */
export function dwellEndsAt(currentTargetSince: Date | null): Date | null {
  return currentTargetSince
    ? new Date(currentTargetSince.getTime() + DWELL_SECONDS * 1000)
    : null;
}

/**
 * Why a session ended, read off how its mission ended.
 *
 * Derived rather than stored: the mission's state and failure reason already say it,
 * and a second column saying it again could disagree with them. A mission that
 * completed ran to its slot's end, because ADR-079 completes a mission nowhere else.
 */
export function sessionEndReasonOf(
  state: MissionState,
  failureReason: MissionFailureReason | null,
): SessionEndReason {
  if (state === "COMPLETE") return "SLOT_ENDED";
  if (failureReason === "SESSION_EXPIRED") return "SLOT_ENDED";
  if (failureReason === "CUSTOMER_CANCELLED") return "CUSTOMER_ENDED";
  if (failureReason === "OPERATOR_ABORT") return "OPERATOR_ENDED";
  if (failureReason === "WEATHER_UNSAFE" || state === "WEATHER_HOLD") return "WEATHER";
  return "FAULT";
}
