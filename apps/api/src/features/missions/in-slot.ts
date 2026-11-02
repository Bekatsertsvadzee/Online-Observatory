import type { ErrorCode, VisibilityBlockReason } from "@darkview/contracts";
import {
  CAPTURE_CLOSE_SECONDS,
  CAPTURE_COOLDOWN_SECONDS,
  MAX_CAPTURES_PER_MISSION,
  RETARGET_CLOSE_SECONDS,
} from "@darkview/db/booked-session";

import type { MintFailure } from "@/features/missions/command";

/**
 * A booked session's in-slot rules (ADR-079), as pure functions of what the cloud
 * already knows. `mintMissionCommand` gathers the facts; these decide, in the order
 * the contract lists for `POST /missions/{missionId}/command`, so the first rule
 * broken is the one the customer is told about.
 */

/**
 * The dwell lock as a client should read it: when a RETARGET stops being refused,
 * or null when it would not be refused now.
 *
 * Waived while the agent reports its picture UNRECOVERED -- the customer must be
 * able to leave an object the telescope cannot show -- and when the current object
 * has left the visible-now list, because it is setting and holding it is pointless.
 */
export function effectiveRetargetAllowedAt(input: {
  dwellEndsAt: Date | null;
  unrecovered: boolean;
  currentListed: boolean;
  now: Date;
}): Date | null {
  const { dwellEndsAt, now } = input;
  if (!dwellEndsAt || dwellEndsAt <= now) return null;
  if (input.unrecovered || !input.currentListed) return null;
  return dwellEndsAt;
}

export type RetargetFacts = {
  state: string;
  now: Date;
  sessionEndsAt: Date;
  currentTargetId: string | null;
  targetId: string;
  dwellEndsAt: Date | null;
  unrecovered: boolean;
  /**
   * Computed only once the cheap rules have passed: the visible-now list is the
   * catalogue judged across the dwell window, and a mission that is slewing has no
   * use for it.
   */
  visibleNow: () => {
    currentListed: boolean;
    requested: { listed: boolean; blockReasons: VisibilityBlockReason[] };
  };
};

export function judgeRetarget(facts: RetargetFacts): MintFailure | null {
  const { now } = facts;

  if (facts.state !== "OBSERVING") {
    return refused("MISSION_BUSY", `A RETARGET waits for OBSERVING; the mission is ${facts.state}.`);
  }
  if (facts.sessionEndsAt.getTime() - now.getTime() < RETARGET_CLOSE_SECONDS * 1000) {
    return refused(
      "SESSION_ENDING",
      `Under ${RETARGET_CLOSE_SECONDS} seconds of the session remain; there is no time to acquire another object.`,
    );
  }
  if (facts.targetId === facts.currentTargetId) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "The telescope is already on this object.",
    };
  }

  const visible = facts.visibleNow();
  const allowedAt = effectiveRetargetAllowedAt({
    dwellEndsAt: facts.dwellEndsAt,
    unrecovered: facts.unrecovered,
    currentListed: visible.currentListed,
    now,
  });
  if (allowedAt) {
    return refused(
      "DWELL_LOCKED",
      "The current object is held for at least ten minutes before the telescope moves on.",
      allowedAt,
    );
  }

  if (!visible.requested.listed) {
    return {
      ok: false,
      status: 409,
      code: "TARGET_NOT_OBSERVABLE",
      message: "That object is not visible now for the next ten minutes.",
      details: {
        rejectionReason: "TARGET_NOT_VISIBLE_NOW",
        blockReasons: visible.requested.blockReasons,
      },
    };
  }

  return null;
}

export type CaptureFacts = {
  state: string;
  now: Date;
  sessionEndsAt: Date;
  /** A CAPTURE for this mission minted and not yet answered by the agent. */
  awaitingVerdict: boolean;
  lastIssuedAt: Date | null;
  captureCount: number;
};

/** When the next CAPTURE is accepted, or null when one is accepted now. */
export function captureCooldownEndsAt(lastIssuedAt: Date | null, now: Date): Date | null {
  if (!lastIssuedAt) return null;
  const endsAt = new Date(lastIssuedAt.getTime() + CAPTURE_COOLDOWN_SECONDS * 1000);
  return endsAt > now ? endsAt : null;
}

export function judgeCapture(facts: CaptureFacts): MintFailure | null {
  const { now } = facts;

  if (facts.awaitingVerdict || facts.state === "CAPTURING" || facts.state === "PROCESSING") {
    return refused("CAPTURE_IN_PROGRESS", "One capture at a time; the last one is still running.");
  }
  const cooldownEndsAt = captureCooldownEndsAt(facts.lastIssuedAt, now);
  if (cooldownEndsAt) {
    return refused(
      "CAPTURE_COOLDOWN",
      `Captures are at least ${CAPTURE_COOLDOWN_SECONDS} seconds apart.`,
      cooldownEndsAt,
    );
  }
  if (facts.captureCount >= MAX_CAPTURES_PER_MISSION) {
    return refused(
      "CAPTURE_LIMIT_REACHED",
      `A session keeps at most ${MAX_CAPTURES_PER_MISSION} captures.`,
    );
  }
  if (facts.sessionEndsAt.getTime() - now.getTime() < CAPTURE_CLOSE_SECONDS * 1000) {
    return refused(
      "SESSION_ENDING",
      `Under ${CAPTURE_CLOSE_SECONDS} seconds of the session remain; a capture could not finish.`,
    );
  }
  return null;
}

function refused(code: ErrorCode, message: string, allowedAt?: Date): MintFailure {
  return {
    ok: false,
    status: 409,
    code,
    message,
    // ErrorCode and CommandRejectionReason share these names (ADR-079).
    details: allowedAt
      ? { rejectionReason: code, allowedAt: allowedAt.toISOString() }
      : { rejectionReason: code },
  };
}
