import type {
  SafetyEnvelopeConfig,
  SlotVisibility,
  VisibilityBlockReason,
} from "@darkview/contracts";
import { VISIBLE_NOW_WINDOW_SECONDS } from "@darkview/db/booked-session";

import type { Site } from "@/lib/ephemeris/engine";
import {
  evaluateSlotVisibility,
  slotSampleInstants,
} from "@/lib/ephemeris/slot-visibility";
import { evaluateVisibility, type VisibilityInput } from "@/lib/ephemeris/visibility";
import { isMeasured } from "@/lib/safety/envelope";

/**
 * What a live session may switch to now (ADR-079).
 *
 * Nothing here is a new rule. Each target is judged by `evaluateSlotVisibility`,
 * the rule `GET /targets/visibility` and `POST /bookings` apply, over a "slot" that
 * is the dwell window: now until min(session end, now + 600 s). A target that
 * passes is one the mount may be sent to and kept on for the whole dwell.
 */
export type VisibleNowTarget<T> = {
  target: T;
  visibility: SlotVisibility;
  observableUntil: Date;
  current: boolean;
};

export type VisibleNow<T> = {
  evaluatedAt: Date;
  windowEndsAt: Date;
  items: VisibleNowTarget<T>[];
  /** Why each target judged and not listed was left out, by target id. */
  blocked: Map<string, VisibilityBlockReason[]>;
};

export function evaluateVisibleNow<T extends VisibilityInput["target"] & { id: string }>(
  input: {
    targets: T[];
    site: Site;
    envelope: SafetyEnvelopeConfig | null;
    observatory: VisibilityInput["observatory"];
    now: Date;
    sessionEndsAt: Date;
    currentTargetId: string | null;
  },
): VisibleNow<T> {
  const { targets, site, envelope, observatory, now, sessionEndsAt } = input;
  const windowEndsAt = new Date(
    Math.max(
      now.getTime(),
      Math.min(sessionEndsAt.getTime(), now.getTime() + VISIBLE_NOW_WINDOW_SECONDS * 1000),
    ),
  );

  // Unmeasured, nothing may be slewed to, so nothing is offered. Said here rather
  // than left to the pointing check, because an unmeasured envelope is not one of
  // the reasons a slot's time decides and the slot judgement would not report it.
  if (!isMeasured(envelope)) {
    const unmeasured: VisibilityBlockReason[] = ["SAFETY_ENVELOPE_UNMEASURED"];
    return {
      evaluatedAt: now,
      windowEndsAt,
      items: [],
      blocked: new Map(targets.map((target) => [target.id, unmeasured])),
    };
  }

  const windowMinutes = (windowEndsAt.getTime() - now.getTime()) / 60_000;
  const midWindow = new Date((now.getTime() + windowEndsAt.getTime()) / 2);
  const judge = (target: T, startAt: Date, durationMinutes: number) =>
    evaluateSlotVisibility({ target, site, envelope, observatory, startAt, durationMinutes });

  const ranked: { item: VisibleNowTarget<T>; altitude: number }[] = [];
  const blocked = new Map<string, VisibilityBlockReason[]>();
  for (const target of targets) {
    const visibility = judge(target, now, windowMinutes);
    if (!visibility.observable) {
      blocked.set(target.id, visibility.blockReasons);
      continue;
    }

    ranked.push({
      item: {
        target,
        visibility,
        observableUntil: observableUntil(target, now, sessionEndsAt, judge),
        current: target.id === input.currentTargetId,
      },
      // The booking's "Best in the sky" rule (clients ADR-063): highest at the
      // window's middle. `expectedMissionMinutes` is not applied -- a switch is not
      // a booking, and the dwell is what has to fit.
      altitude: evaluateVisibility({ target, site, envelope, observatory, at: midWindow })
        .horizontal.altitudeDegrees,
    });
  }

  ranked.sort(
    (a, b) => b.altitude - a.altitude || a.item.target.slug.localeCompare(b.item.target.slug),
  );
  return { evaluatedAt: now, windowEndsAt, items: ranked.map(({ item }) => item), blocked };
}

/**
 * The last five-minute step, at or before the session's end, up to which every step
 * passes. Starts from a target already known to pass the dwell window.
 */
function observableUntil<T>(
  target: T,
  now: Date,
  sessionEndsAt: Date,
  judge: (target: T, startAt: Date, durationMinutes: number) => SlotVisibility,
): Date {
  const minutes = Math.max(0, (sessionEndsAt.getTime() - now.getTime()) / 60_000);
  let last = now;
  for (const at of slotSampleInstants(now, minutes)) {
    if (!judge(target, at, 0).observable) break;
    last = at;
  }
  return last;
}
