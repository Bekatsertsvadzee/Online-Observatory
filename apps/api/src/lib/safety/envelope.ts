import type {
  AzimuthSector,
  CommandRejectionReason,
  HorizonMaskEntry,
  SafetyEnvelopeConfig,
} from "@darkview/contracts";

import {
  horizontalSeparationDegrees,
  sunHorizontal,
  type Site,
} from "@/lib/ephemeris/engine";

/**
 * The cloud's half of the two-layer safety design.
 *
 * `CLAUDE.md`: "The cloud validates commands; the local agent validates them
 * again. A cloud-approved command that fails local safety is refused." This is the
 * first of those two checks. Until it existed the cloud minted commands it had
 * never examined, and the entire safety argument rested on one implementation.
 *
 * THIS IS A DELIBERATE SECOND IMPLEMENTATION OF `agent/darkview_agent/safety/envelope.py`.
 *
 * It is not shared code and must never become shared code. Two independent
 * implementations that agree are evidence; one implementation called twice is a
 * single point of failure wearing a safety label. A bug written once would be
 * enforced identically on both sides and caught by neither. If you are here to
 * remove the duplication, the duplication is the feature -- read ADR-001's
 * reasoning about independent validation first, and ask the maintainer.
 *
 * What must stay in step is the *decision*, not the code: same rule order, same
 * `CommandRejectionReason` for the same condition. `sun-exclusion-agreement.test.ts`
 * is what proves the one calculation both sides derive independently still agrees.
 *
 * Every function here is pure. Time is passed in, never read, so each rule is
 * testable at its boundary.
 */

export type SafetyVerdict =
  | { permitted: true }
  | { permitted: false; reason: CommandRejectionReason; detail: string };

export const PERMITTED: SafetyVerdict = { permitted: true };

function refuse(reason: CommandRejectionReason, detail: string): SafetyVerdict {
  return { permitted: false, reason, detail };
}

/**
 * True only when MAX_ALT_SAFE has been physically measured.
 *
 * A missing envelope and an envelope whose `maxAltitudeDegrees` is null are both
 * UNMEASURED. There is no third state and no default value: the Build Plan prints
 * a provisional 72 degrees, and that number must never reach a running system.
 */
export function isMeasured(config: SafetyEnvelopeConfig | null): boolean {
  return config !== null && config.maxAltitudeDegrees !== null;
}

/** Wrap a bearing into 0..360. */
export function normaliseAzimuth(azimuthDegrees: number): number {
  return ((azimuthDegrees % 360) + 360) % 360;
}

/**
 * Inclusive start, exclusive end, clockwise from north.
 *
 * Handles a sector that wraps through north, such as 350..10, which a naive
 * `from <= a < to` gets exactly backwards.
 */
export function azimuthInSector(
  azimuthDegrees: number,
  fromDegrees: number,
  toDegrees: number,
): boolean {
  const azimuth = normaliseAzimuth(azimuthDegrees);
  const start = normaliseAzimuth(fromDegrees);
  const end = normaliseAzimuth(toDegrees);

  if (start === end) return false;
  if (start < end) return start <= azimuth && azimuth < end;
  return azimuth >= start || azimuth < end;
}

/**
 * The surveyed minimum altitude at this bearing.
 *
 * The compass survey samples bearings; between samples the horizon is interpolated
 * linearly, wrapping across north. Null when no survey exists, in which case the
 * mask imposes no constraint and the flat minimum altitude alone applies.
 */
export function horizonMinimumAltitude(
  azimuthDegrees: number,
  mask: HorizonMaskEntry[],
): number | null {
  if (mask.length === 0) return null;

  const azimuth = normaliseAzimuth(azimuthDegrees);
  const entries = [...mask].sort(
    (a, b) => normaliseAzimuth(a.azimuthDegrees) - normaliseAzimuth(b.azimuthDegrees),
  );

  if (entries.length === 1) return entries[0].minAltitudeDegrees;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryAzimuth = normaliseAzimuth(entry.azimuthDegrees);
    if (entryAzimuth === azimuth) return entry.minAltitudeDegrees;
    if (entryAzimuth > azimuth) {
      // Before the first sample, interpolate from the last one across north.
      const previous = index === 0 ? entries[entries.length - 1] : entries[index - 1];
      const previousAzimuth =
        index === 0
          ? normaliseAzimuth(previous.azimuthDegrees) - 360
          : normaliseAzimuth(previous.azimuthDegrees);
      const span = entryAzimuth - previousAzimuth;
      const fraction = span === 0 ? 0 : (azimuth - previousAzimuth) / span;
      return (
        previous.minAltitudeDegrees +
        (entry.minAltitudeDegrees - previous.minAltitudeDegrees) * fraction
      );
    }
  }

  // Past the last sample, interpolate to the first across north.
  const last = entries[entries.length - 1];
  const first = entries[0];
  const lastAzimuth = normaliseAzimuth(last.azimuthDegrees);
  const firstAzimuth = normaliseAzimuth(first.azimuthDegrees) + 360;
  const span = firstAzimuth - lastAzimuth;
  const fraction = span === 0 ? 0 : (azimuth - lastAzimuth) / span;
  return (
    last.minAltitudeDegrees +
    (first.minAltitudeDegrees - last.minAltitudeDegrees) * fraction
  );
}

/**
 * Decide whether the telescope may point here, at this instant.
 *
 * Checks run most-fundamental first, so the reason returned is the most important
 * thing wrong rather than whichever rule happened to be tested last. The order is
 * the agent's order, deliberately: when both sides refuse, they should refuse for
 * the same stated reason, or an operator reading two audit trails sees a
 * disagreement that is not there.
 *
 * `operatorOverride` permits attended terrestrial testing during daylight. It has
 * no effect on the Sun exclusion, which cannot be disabled, bypassed or widened by
 * any flag, override or configuration value.
 */
export function evaluatePointing(input: {
  config: SafetyEnvelopeConfig | null;
  site: Site | null;
  at: Date;
  altitudeDegrees: number;
  azimuthDegrees: number;
  operatorOverride?: boolean;
}): SafetyVerdict {
  const { config, site, at, altitudeDegrees, azimuthDegrees } = input;
  const operatorOverride = input.operatorOverride ?? false;

  // 1. Unmeasured beats everything. Without a measured MAX_ALT_SAFE nothing moves.
  if (!isMeasured(config) || config === null || config.maxAltitudeDegrees === null) {
    return refuse(
      "SAFETY_ENVELOPE_UNMEASURED",
      "MAX_ALT_SAFE is UNMEASURED. It is measured from the physical optical train " +
        "during mount qualification, never guessed and never defaulted.",
    );
  }

  // 2. Where we are must be known before the Sun can be computed. Fail closed: an
  //    unknown site cannot prove the pointing is clear of the Sun.
  if (site === null) {
    return refuse(
      "SAFETY_SUN_EXCLUSION",
      "Observatory coordinates are not configured, so the Sun's position cannot be " +
        "computed. Sun avoidance is never assumed.",
    );
  }

  const sun = sunHorizontal(at, site);

  // 3. Sun exclusion. Not overridable, by anything, ever.
  const separation = horizontalSeparationDegrees(
    { altitudeDegrees, azimuthDegrees },
    sun,
  );
  if (separation < config.sunExclusionDegrees) {
    return refuse(
      "SAFETY_SUN_EXCLUSION",
      `Pointing is ${separation.toFixed(2)} degrees from the Sun; the exclusion is ` +
        `${config.sunExclusionDegrees.toFixed(2)} degrees. This cannot be overridden.`,
    );
  }

  // 4. Daylight lock. Overridable for attended terrestrial testing, and even then
  //    the Sun exclusion above has already been enforced.
  if (sun.altitudeDegrees > config.daylightLockSunAltitudeDegrees && !operatorOverride) {
    return refuse(
      "SAFETY_DAYLIGHT_LOCK",
      `The Sun is at ${sun.altitudeDegrees.toFixed(2)} degrees altitude; the daylight ` +
        `lock is ${config.daylightLockSunAltitudeDegrees.toFixed(2)}.`,
    );
  }

  // 5. Altitude limits.
  if (altitudeDegrees < config.minAltitudeDegrees) {
    return refuse(
      "SAFETY_BELOW_MIN_ALTITUDE",
      `Altitude ${altitudeDegrees.toFixed(2)} is below the minimum ` +
        `${config.minAltitudeDegrees.toFixed(2)}.`,
    );
  }
  if (altitudeDegrees > config.maxAltitudeDegrees) {
    return refuse(
      "SAFETY_ABOVE_MAX_ALTITUDE",
      `Altitude ${altitudeDegrees.toFixed(2)} is above the measured MAX_ALT_SAFE ` +
        `${config.maxAltitudeDegrees.toFixed(2)}.`,
    );
  }

  // 6. Horizon mask from the compass survey.
  const surveyed = horizonMinimumAltitude(azimuthDegrees, config.horizonMask);
  if (surveyed !== null && altitudeDegrees < surveyed) {
    return refuse(
      "SAFETY_HORIZON_MASK",
      `Altitude ${altitudeDegrees.toFixed(2)} at bearing ` +
        `${normaliseAzimuth(azimuthDegrees).toFixed(2)} is below the surveyed horizon ` +
        `${surveyed.toFixed(2)}.`,
    );
  }

  // 7. Cable-wrap exclusion sectors.
  for (const sector of config.forbiddenAzimuthSectors as AzimuthSector[]) {
    if (azimuthInSector(azimuthDegrees, sector.fromDegrees, sector.toDegrees)) {
      return refuse(
        "SAFETY_FORBIDDEN_AZIMUTH",
        `Bearing ${normaliseAzimuth(azimuthDegrees).toFixed(2)} is inside the forbidden ` +
          `sector ${sector.fromDegrees.toFixed(2)}..${sector.toDegrees.toFixed(2)}.`,
      );
    }
  }

  return PERMITTED;
}

/**
 * Decide whether a customer nudge step is within bounds.
 *
 * Only the part of the agent's `evaluate_nudge` the cloud can honestly answer. The
 * cumulative offset is the agent's: it is the only party that knows where the mount
 * actually is, and inventing a cloud-side copy would be a second number that drifts
 * from the real one and then contradicts it. So the cloud bounds the step, the
 * agent bounds the total, and a nudge has to satisfy both.
 */
export function evaluateNudgeStep(
  config: SafetyEnvelopeConfig | null,
  requestedStepDegrees: number,
): SafetyVerdict {
  if (!isMeasured(config) || config === null) {
    return refuse(
      "SAFETY_ENVELOPE_UNMEASURED",
      "MAX_ALT_SAFE is UNMEASURED; no motion is permitted.",
    );
  }

  if (requestedStepDegrees < 0) {
    return refuse(
      "SAFETY_NUDGE_LIMIT_EXCEEDED",
      "A nudge step must not be negative; direction is carried separately.",
    );
  }

  if (requestedStepDegrees > config.nudgeRateDegreesPerSecond) {
    return refuse(
      "SAFETY_SLEW_RATE",
      `Nudge step ${requestedStepDegrees.toFixed(4)} exceeds the permitted step ` +
        `${config.nudgeRateDegreesPerSecond.toFixed(4)}.`,
    );
  }

  if (requestedStepDegrees > config.nudgeMaxDegrees) {
    return refuse(
      "SAFETY_NUDGE_LIMIT_EXCEEDED",
      `Nudge step ${requestedStepDegrees.toFixed(4)} alone exceeds the cumulative limit ` +
        `${config.nudgeMaxDegrees.toFixed(4)}.`,
    );
  }

  return PERMITTED;
}
