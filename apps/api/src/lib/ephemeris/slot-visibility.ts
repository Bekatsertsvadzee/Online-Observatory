import type {
  CommandRejectionReason,
  SafetyEnvelopeConfig,
  SlotVisibility,
  VisibilityBlockReason,
} from "@darkview/contracts";

import { horizontalAirlessOf, type Site } from "@/lib/ephemeris/engine";
import {
  equatorialFor,
  evaluateVisibility,
  type VisibilityInput,
} from "@/lib/ephemeris/visibility";
import { evaluatePointing } from "@/lib/safety/envelope";

/**
 * Whether a target can be delivered across one slot (#151).
 *
 * Nothing here is a second ephemeris or a second safety check. Each instant is
 * judged by `evaluateVisibility`, the rule `GET /targets/tonight` serves, and by
 * `evaluatePointing`, the rule that refuses the slew when the mission starts. A
 * target that passes both at every sampled instant is one the slot can deliver;
 * one that fails either at any instant would end NOT_VISIBLE, or be refused at the
 * GOTO, after the customer had paid.
 */

/**
 * How far apart the sampled instants are. A target moves about a degree and a
 * quarter of hour angle in five minutes, so an edge -- setting below the minimum
 * altitude, crossing into a mask notch -- is found within that much of where it is.
 */
export const SLOT_SAMPLE_MINUTES = 5;

/**
 * The reasons a slot's time decides for one target.
 *
 * Left out, on purpose: OBSERVATORY_OFFLINE, WEATHER_HOLD and
 * SAFETY_ENVELOPE_UNMEASURED are conditions of the whole observatory, which
 * `GET /slots` and the mission start own; DOES_NOT_FIT_FIELD is a fact about the
 * target and its optics that no slot changes, and the Moon -- the one target it
 * names -- is sold as the terminator close-up.
 */
const SLOT_BLOCK_REASONS: ReadonlySet<VisibilityBlockReason> = new Set([
  "TARGET_DISABLED",
  "BELOW_HORIZON",
  "BELOW_MIN_ALTITUDE",
  "ABOVE_MAX_ALTITUDE",
  "BEHIND_HORIZON_MASK",
  "IN_FORBIDDEN_AZIMUTH",
  "SUN_TOO_HIGH",
  "TOO_CLOSE_TO_SUN",
  "TOO_CLOSE_TO_MOON",
]);

/** The slew refusal a pointing verdict gives, as the visibility reason it means. */
const POINTING_REASON: Partial<Record<CommandRejectionReason, VisibilityBlockReason>> = {
  SAFETY_BELOW_MIN_ALTITUDE: "BELOW_MIN_ALTITUDE",
  SAFETY_ABOVE_MAX_ALTITUDE: "ABOVE_MAX_ALTITUDE",
  SAFETY_HORIZON_MASK: "BEHIND_HORIZON_MASK",
  SAFETY_FORBIDDEN_AZIMUTH: "IN_FORBIDDEN_AZIMUTH",
  SAFETY_SUN_EXCLUSION: "TOO_CLOSE_TO_SUN",
  SAFETY_DAYLIGHT_LOCK: "SUN_TOO_HIGH",
};

/** The slot's start, every SLOT_SAMPLE_MINUTES after it, and its end. */
export function slotSampleInstants(startAt: Date, durationMinutes: number): Date[] {
  const endMs = startAt.getTime() + durationMinutes * 60_000;
  const instants: Date[] = [];
  for (let ms = startAt.getTime(); ms < endMs; ms += SLOT_SAMPLE_MINUTES * 60_000) {
    instants.push(new Date(ms));
  }
  instants.push(new Date(endMs));
  return instants;
}

export function evaluateSlotVisibility(input: {
  target: VisibilityInput["target"];
  site: Site;
  envelope: SafetyEnvelopeConfig | null;
  observatory: VisibilityInput["observatory"];
  startAt: Date;
  durationMinutes: number;
}): SlotVisibility {
  const { target, site, envelope, observatory, startAt, durationMinutes } = input;
  const found = new Set<VisibilityBlockReason>();
  let atStart: SlotVisibility["atStart"] | null = null;

  for (const at of slotSampleInstants(startAt, durationMinutes)) {
    const visibility = evaluateVisibility({ target, site, envelope, observatory, at });
    atStart ??= visibility;

    for (const reason of visibility.blockReasons) {
      if (SLOT_BLOCK_REASONS.has(reason)) found.add(reason);
    }

    // Below the horizon there is nothing more to say about where it points.
    if (visibility.blockReasons.includes("BELOW_HORIZON")) continue;

    // The airless position, as the mission start judges it: the refracted one
    // would pass a pointing the slew then refuses.
    const horizontal = horizontalAirlessOf(equatorialFor(target, at, site), at, site);
    const verdict = evaluatePointing({
      config: envelope,
      site,
      at,
      altitudeDegrees: horizontal.altitudeDegrees,
      azimuthDegrees: horizontal.azimuthDegrees,
    });
    const reason = verdict.permitted ? undefined : POINTING_REASON[verdict.reason];
    if (reason) found.add(reason);
  }

  return {
    observable: found.size === 0,
    blockReasons: [...found],
    atStart: atStart as SlotVisibility["atStart"],
  };
}
