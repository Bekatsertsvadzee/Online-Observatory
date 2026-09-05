import {
  Body,
  DefineStar,
  Equator,
  Horizon,
  MakeTime,
  Observer,
  SearchRiseSet,
} from "astronomy-engine";

import type {
  EquatorialCoordinates,
  HorizontalCoordinates,
  SolarSystemBody,
} from "@darkview/contracts";

/**
 * Positions, computed at request time.
 *
 * The catalogue stores where a fixed target is and, for the Moon and planets,
 * only which body it is. Both end up here, and nothing is cached: the contract
 * requires visibility to be "computed at request time from live ephemeris, never
 * cached as a static list", and an altitude is only true for the instant it was
 * computed for.
 *
 * The agent computes the Sun independently, from its own NOAA/Meeus code and its
 * own site coordinates, and refuses commands on that basis. It is deliberately
 * not this library: two implementations that agree are evidence, one shared
 * implementation used twice is not. `sun-agreement.test.ts` compares them.
 */

export type Site = {
  latitudeDegrees: number;
  longitudeDegrees: number;
  elevationMetres?: number;
};

const BODIES: Record<SolarSystemBody, Body> = {
  MOON: Body.Moon,
  MERCURY: Body.Mercury,
  VENUS: Body.Venus,
  MARS: Body.Mars,
  JUPITER: Body.Jupiter,
  SATURN: Body.Saturn,
  URANUS: Body.Uranus,
  NEPTUNE: Body.Neptune,
};

function observerOf(site: Site): Observer {
  return new Observer(
    site.latitudeDegrees,
    site.longitudeDegrees,
    site.elevationMetres ?? 0,
  );
}

/** Where a solar-system body is, in J2000 equatorial coordinates, at `at`. */
export function equatorialOfBody(
  body: SolarSystemBody,
  at: Date,
  site: Site,
): EquatorialCoordinates {
  const equator = Equator(BODIES[body], MakeTime(at), observerOf(site), false, true);
  return { raHours: equator.ra, decDegrees: equator.dec, epoch: "J2000" };
}

/**
 * Equatorial to horizontal for the observer's sky.
 *
 * `normal` refraction is applied: it is what an observer and a camera actually
 * see, and near the horizon it lifts an object by around half a degree. Since the
 * minimum-altitude rule is checked against this number, using the airless value
 * would reject targets that are in fact visible.
 */
export function horizontalOf(
  coordinates: EquatorialCoordinates,
  at: Date,
  site: Site,
): HorizontalCoordinates {
  const horizon = Horizon(
    MakeTime(at),
    observerOf(site),
    coordinates.raHours,
    coordinates.decDegrees,
    "normal",
  );
  return { altitudeDegrees: horizon.altitude, azimuthDegrees: horizon.azimuth };
}

/**
 * The Sun's altitude, WITHOUT refraction -- deliberately unlike targets above.
 *
 * The agent computes the Sun airless for a stated reason: refraction lifts the
 * apparent Sun by roughly half a degree near the horizon, so ignoring it makes
 * the daylight lock trigger very slightly early, and erring toward "the Sun is
 * up" is the safe direction. The cloud pre-validates against the same rule, so
 * it uses the same convention. Applying refraction here would make the cloud
 * marginally more permissive than the agent, which is the wrong way round -- and
 * would put a half-degree wedge into the agreement test for no benefit.
 */
/**
 * Where a target is, altitude and azimuth, with no refraction applied.
 *
 * `horizontalOf` above is what the API *serves*: refracted, because that is where
 * the observer's eye finds the object. This is what the safety envelope *judges*,
 * because the agent's envelope applies no refraction at all and the two have to be
 * deciding about the same number.
 *
 * The difference is not decorative. Refraction lifts an object by up to about half
 * a degree near the horizon, so pre-validating a refracted altitude would make the
 * cloud quietly more permissive than the agent exactly where the horizon mask and
 * the minimum altitude matter most: the cloud would approve a pointing the agent
 * then refuses, and the two audit trails would disagree about the same command.
 * `sun-exclusion-agreement.test.ts` is what caught that.
 */
export function horizontalAirlessOf(
  coordinates: EquatorialCoordinates,
  at: Date,
  site: Site,
): HorizontalCoordinates {
  const horizon = Horizon(
    MakeTime(at),
    observerOf(site),
    coordinates.raHours,
    coordinates.decDegrees,
  );
  return { altitudeDegrees: horizon.altitude, azimuthDegrees: horizon.azimuth };
}

export function sunAltitudeDegrees(at: Date, site: Site): number {
  return sunHorizontal(at, site).altitudeDegrees;
}

/**
 * Where the Sun is, altitude and azimuth, airless.
 *
 * The safety envelope needs both: the daylight lock reads the altitude, and the
 * Sun exclusion is an angular separation between where the telescope would point
 * and where the Sun is, which needs the bearing too.
 *
 * Airless for the same reason as above, and it matters more here. Refraction lifts
 * the Sun, so a refracted position would put the cloud's Sun a fraction of a degree
 * away from the agent's, and the two are compared against each other in
 * `sun-exclusion-agreement.test.ts`.
 */
export function sunHorizontal(at: Date, site: Site): HorizontalCoordinates {
  const sun = Equator(Body.Sun, MakeTime(at), observerOf(site), true, true);
  const airless = Horizon(MakeTime(at), observerOf(site), sun.ra, sun.dec);
  return { altitudeDegrees: airless.altitude, azimuthDegrees: airless.azimuth };
}

/**
 * Great-circle angle between two horizontal positions, in degrees.
 *
 * The equatorial version above works on right ascension and declination. This one
 * works on altitude and azimuth, which is what the Sun exclusion compares: a
 * pointing the mount would take against where the Sun actually is in the sky.
 */
export function horizontalSeparationDegrees(
  left: HorizontalCoordinates,
  right: HorizontalCoordinates,
): number {
  const toRadians = Math.PI / 180;
  const alt1 = left.altitudeDegrees * toRadians;
  const alt2 = right.altitudeDegrees * toRadians;
  const az1 = left.azimuthDegrees * toRadians;
  const az2 = right.azimuthDegrees * toRadians;

  const cosine =
    Math.sin(alt1) * Math.sin(alt2) +
    Math.cos(alt1) * Math.cos(alt2) * Math.cos(az2 - az1);

  return Math.acos(Math.min(1, Math.max(-1, cosine))) / toRadians;
}

/** Great-circle angle between two equatorial positions, in degrees. */
export function angularSeparationDegrees(
  left: EquatorialCoordinates,
  right: EquatorialCoordinates,
): number {
  const toRadians = Math.PI / 180;
  const ra1 = left.raHours * 15 * toRadians;
  const ra2 = right.raHours * 15 * toRadians;
  const dec1 = left.decDegrees * toRadians;
  const dec2 = right.decDegrees * toRadians;

  const cosine =
    Math.sin(dec1) * Math.sin(dec2) +
    Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);

  return Math.acos(Math.min(1, Math.max(-1, cosine))) / toRadians;
}

export function moonSeparationDegrees(
  coordinates: EquatorialCoordinates,
  at: Date,
  site: Site,
): number {
  return angularSeparationDegrees(coordinates, equatorialOfBody("MOON", at, site));
}

/**
 * When the target next crosses the horizon, searching forward a day. Null means
 * it does not cross within that window -- circumpolar, or never up.
 */
export function riseSet(
  coordinates: EquatorialCoordinates,
  at: Date,
  site: Site,
): { risesAt: string | null; setsAt: string | null } {
  const observer = observerOf(site);

  // DefineStar writes into a fixed global slot in the library, so the definition
  // has to happen immediately before each search and cannot be hoisted. Node is
  // single-threaded per request here, and nothing between these two lines yields.
  const search = (direction: 1 | -1) => {
    try {
      DefineStar(Body.Star1, coordinates.raHours, coordinates.decDegrees, 1000);
      const found = SearchRiseSet(Body.Star1, observer, direction, MakeTime(at), 1);
      return found ? found.date.toISOString() : null;
    } catch {
      // Circumpolar or never-rising targets have no crossing; the contract models
      // that as null rather than as an error.
      return null;
    }
  };

  return { risesAt: search(1), setsAt: search(-1) };
}
