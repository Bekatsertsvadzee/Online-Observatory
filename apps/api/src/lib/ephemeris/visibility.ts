import type {
  EquatorialCoordinates,
  TargetVisibility,
  VisibilityBlockReason,
} from "@darkview/contracts";

import {
  equatorialOfBody,
  horizontalOf,
  moonSeparationDegrees,
  riseSet,
  sunAltitudeDegrees,
  type Site,
} from "@/lib/ephemeris/engine";

/**
 * Build Plan section 01, the rule to encode in the database:
 *
 *   "A target may only be offered when all four are true: its altitude exceeds
 *    25 degrees, its angular size fits the selected configuration, the Sun is
 *    more than 12 degrees below the horizon (18 for deep sky), and it is more
 *    than 30 degrees from the Moon if it is a faint object."
 *
 * Every rejection names a reason. Silently dropping a target from the list gives
 * a customer no way to understand why the thing they wanted is not offered, and
 * gives an operator nothing to debug.
 */

/** Sun altitude below which a solar-system target may be observed. */
export const SUN_ALTITUDE_SOLAR_SYSTEM = -12;

/** Deep sky needs true astronomical darkness. */
export const SUN_ALTITUDE_DEEP_SKY = -18;

/** A faint target this close to the Moon is washed out. */
export const MOON_SEPARATION_MINIMUM_DEGREES = 30;

/** Fainter than this counts as faint for the Moon rule. */
export const FAINT_MAGNITUDE_THRESHOLD = 6;

/** Field of view, in arcminutes, for each optical configuration. */
export const FIELD_OF_VIEW_ARCMIN = {
  F20_BARLOW: 12.8,
  F10_NATIVE: 25.5,
  F6_3_REDUCER: 40.5,
} as const;

export type VisibilityInput = {
  target: {
    slug: string;
    type: string;
    enabled: boolean;
    magnitude: number;
    angularSizeArcmin: number;
    minAltitudeDegrees: number;
    opticalConfig: keyof typeof FIELD_OF_VIEW_ARCMIN;
    positionSource: "FIXED" | "EPHEMERIS";
    solarSystemBody: string | null;
    rightAscensionHours: number | null;
    declinationDegrees: number | null;
  };
  site: Site;
  envelope: {
    /** Null means UNMEASURED. Nothing is offered while it is null. */
    maxAltitudeDegrees: number | null;
    minAltitudeDegrees: number;
  } | null;
  observatory: { online: boolean; weatherHold: boolean };
  at: Date;
};

const SOLAR_SYSTEM_TYPES = new Set(["MOON", "PLANET"]);

export function equatorialFor(
  target: VisibilityInput["target"],
  at: Date,
  site: Site,
): EquatorialCoordinates {
  if (target.positionSource === "EPHEMERIS") {
    if (!target.solarSystemBody) {
      throw new Error(`${target.slug} is EPHEMERIS but names no body`);
    }
    return equatorialOfBody(
      target.solarSystemBody as Parameters<typeof equatorialOfBody>[0],
      at,
      site,
    );
  }

  if (target.rightAscensionHours === null || target.declinationDegrees === null) {
    throw new Error(`${target.slug} is FIXED but has no coordinates`);
  }

  return {
    raHours: target.rightAscensionHours,
    decDegrees: target.declinationDegrees,
    epoch: "J2000",
  };
}

export function evaluateVisibility(input: VisibilityInput): TargetVisibility {
  const { target, site, envelope, observatory, at } = input;

  const coordinates = equatorialFor(target, at, site);
  const horizontal = horizontalOf(coordinates, at, site);
  const sunAltitude = sunAltitudeDegrees(at, site);
  const moonSeparation = moonSeparationDegrees(coordinates, at, site);

  const blockReasons: VisibilityBlockReason[] = [];

  // Safety first, and unconditionally. While MAX_ALT_SAFE is unmeasured the
  // system does not know where the optical train collides with the mount, so no
  // target is offered -- there is nothing to weigh this against.
  if (!envelope || envelope.maxAltitudeDegrees === null) {
    blockReasons.push("SAFETY_ENVELOPE_UNMEASURED");
  }

  if (!target.enabled) blockReasons.push("TARGET_DISABLED");
  if (!observatory.online) blockReasons.push("OBSERVATORY_OFFLINE");
  if (observatory.weatherHold) blockReasons.push("WEATHER_HOLD");

  if (horizontal.altitudeDegrees <= 0) {
    blockReasons.push("BELOW_HORIZON");
  } else if (horizontal.altitudeDegrees < target.minAltitudeDegrees) {
    blockReasons.push("BELOW_MIN_ALTITUDE");
  }

  if (
    envelope?.maxAltitudeDegrees !== null &&
    envelope !== null &&
    horizontal.altitudeDegrees > envelope.maxAltitudeDegrees
  ) {
    blockReasons.push("ABOVE_MAX_ALTITUDE");
  }

  const isSolarSystem = SOLAR_SYSTEM_TYPES.has(target.type);
  const sunLimit = isSolarSystem ? SUN_ALTITUDE_SOLAR_SYSTEM : SUN_ALTITUDE_DEEP_SKY;
  if (sunAltitude > sunLimit) blockReasons.push("SUN_TOO_HIGH");

  // The Moon rule applies to faint objects. The Moon itself is exempt for the
  // obvious reason, and the planets are bright enough not to care.
  const isFaint = !isSolarSystem && target.magnitude > FAINT_MAGNITUDE_THRESHOLD;
  if (isFaint && moonSeparation < MOON_SEPARATION_MINIMUM_DEGREES) {
    blockReasons.push("TOO_CLOSE_TO_MOON");
  }

  if (target.angularSizeArcmin > FIELD_OF_VIEW_ARCMIN[target.opticalConfig]) {
    // The Moon is the known case: 31' against a 25.5' field. The product is the
    // terminator close-up, so this is not a defect, but it is still a fact the
    // API states rather than hides.
    blockReasons.push("DOES_NOT_FIT_FIELD");
  }

  const { risesAt, setsAt } = riseSet(coordinates, at, site);

  return {
    observable: blockReasons.length === 0,
    evaluatedAt: at.toISOString(),
    horizontal,
    sunAltitudeDegrees: sunAltitude,
    moonSeparationDegrees: moonSeparation,
    risesAt,
    setsAt,
    blockReasons,
  };
}
