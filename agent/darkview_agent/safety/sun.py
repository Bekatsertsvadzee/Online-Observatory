"""Solar position, computed here.

Acceptance criterion 6 of DV-023: the Sun's position is computed inside the agent
and never taken from a cloud payload. The reason is the whole point of the
two-layer safety design — if the cloud told the agent where the Sun was, then a
compromised, buggy or simply stale cloud could walk the telescope onto the Sun,
and the agent's independent check would be independent in name only.

NOAA's solar position algorithm (after Meeus, *Astronomical Algorithms*). Accurate
to well under a degree, which is far finer than any exclusion radius we enforce.

Every function here is pure. Time is always passed in; nothing reads a clock.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime


@dataclass(frozen=True)
class SiteLocation:
    """Where the observatory physically is.

    Local agent configuration, deliberately not part of contracts/openapi.yaml.
    It never crosses a process boundary: the agent computes the Sun from its own
    coordinates so that the check cannot be influenced from outside.
    """

    latitude_degrees: float
    longitude_degrees: float

    def __post_init__(self) -> None:
        if not -90.0 <= self.latitude_degrees <= 90.0:
            raise ValueError("latitude must be within -90..90")
        if not -180.0 <= self.longitude_degrees <= 180.0:
            raise ValueError("longitude must be within -180..180")


@dataclass(frozen=True)
class SunPosition:
    altitude_degrees: float
    azimuth_degrees: float


@dataclass(frozen=True)
class EquatorialPosition:
    right_ascension_hours: float
    declination_degrees: float


def _julian_day(moment: datetime) -> float:
    """Julian Day for a timezone-aware UTC instant."""
    if moment.tzinfo is None:
        raise ValueError("moment must be timezone-aware")

    utc = moment.astimezone(UTC)
    year, month = utc.year, utc.month
    day = utc.day + (utc.hour + utc.minute / 60.0 + utc.second / 3600.0) / 24.0

    if month <= 2:
        year -= 1
        month += 12

    a = year // 100
    b = 2 - a + a // 4
    return (
        math.floor(365.25 * (year + 4716))
        + math.floor(30.6001 * (month + 1))
        + day
        + b
        - 1524.5
    )


def _solar_elements(moment: datetime) -> tuple[float, float, float, float, float]:
    """The shared intermediate quantities of the NOAA algorithm.

    Returns (century, mean_longitude, mean_anomaly, eccentricity, obliquity).
    Extracted so `position()` and `equatorial_position()` derive from exactly the
    same numbers rather than from two copies that could drift apart.
    """
    century = (_julian_day(moment) - 2451545.0) / 36525.0

    mean_longitude = (280.46646 + century * (36000.76983 + century * 0.0003032)) % 360.0
    mean_anomaly = 357.52911 + century * (35999.05029 - 0.0001537 * century)
    eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century)

    omega = 125.04 - 1934.136 * century
    # Mean obliquity of the ecliptic, in degrees-minutes-seconds form.
    obliquity_seconds = 21.448 - century * (
        46.815 + century * (0.00059 - century * 0.001813)
    )
    mean_obliquity = 23.0 + (26.0 + obliquity_seconds / 60.0) / 60.0
    obliquity = mean_obliquity + 0.00256 * math.cos(math.radians(omega))

    return century, mean_longitude, mean_anomaly, eccentricity, obliquity


def _apparent_longitude(century: float, mean_longitude: float, mean_anomaly: float) -> float:
    """The Sun's apparent ecliptic longitude, in degrees."""
    anomaly_radians = math.radians(mean_anomaly)
    center = (
        math.sin(anomaly_radians) * (1.914602 - century * (0.004817 + 0.000014 * century))
        + math.sin(2 * anomaly_radians) * (0.019993 - 0.000101 * century)
        + math.sin(3 * anomaly_radians) * 0.000289
    )
    omega = 125.04 - 1934.136 * century
    return mean_longitude + center - 0.00569 - 0.00478 * math.sin(math.radians(omega))


def position(moment: datetime, site: SiteLocation) -> SunPosition:
    """The Sun's apparent altitude and azimuth at this instant, from this site.

    Azimuth is measured clockwise from north, matching the mount and the
    horizon mask. Altitude is uncorrected for atmospheric refraction: refraction
    lifts the apparent Sun by roughly half a degree near the horizon, and
    ignoring it makes the daylight lock trigger very slightly early. Erring
    toward "the Sun is up" is the safe direction.
    """
    century, mean_longitude, mean_anomaly, eccentricity, obliquity = _solar_elements(moment)
    apparent_longitude = _apparent_longitude(century, mean_longitude, mean_anomaly)

    apparent_radians = math.radians(apparent_longitude)
    obliquity_radians = math.radians(obliquity)
    declination = math.degrees(
        math.asin(math.sin(obliquity_radians) * math.sin(apparent_radians))
    )

    # Equation of time, in minutes.
    anomaly_radians = math.radians(mean_anomaly)
    y = math.tan(obliquity_radians / 2.0) ** 2
    mean_longitude_radians = math.radians(mean_longitude)
    equation_of_time = 4.0 * math.degrees(
        y * math.sin(2 * mean_longitude_radians)
        - 2 * eccentricity * math.sin(anomaly_radians)
        + 4 * eccentricity * y * math.sin(anomaly_radians) * math.cos(2 * mean_longitude_radians)
        - 0.5 * y * y * math.sin(4 * mean_longitude_radians)
        - 1.25 * eccentricity * eccentricity * math.sin(2 * anomaly_radians)
    )

    utc = moment.astimezone(UTC)
    minutes_utc = utc.hour * 60.0 + utc.minute + utc.second / 60.0
    true_solar_time = (minutes_utc + equation_of_time + 4.0 * site.longitude_degrees) % 1440.0

    # true_solar_time is already reduced modulo 1440, so this lands in [-180, 180)
    # by construction. No wrap correction is reachable here, and adding one would
    # imply a condition that cannot occur.
    hour_angle = true_solar_time / 4.0 - 180.0

    latitude_radians = math.radians(site.latitude_degrees)
    declination_radians = math.radians(declination)
    hour_angle_radians = math.radians(hour_angle)

    cosine_zenith = math.sin(latitude_radians) * math.sin(declination_radians) + math.cos(
        latitude_radians
    ) * math.cos(declination_radians) * math.cos(hour_angle_radians)
    cosine_zenith = max(-1.0, min(1.0, cosine_zenith))
    zenith = math.degrees(math.acos(cosine_zenith))
    altitude = 90.0 - zenith

    sine_zenith = math.sin(math.radians(zenith))
    if abs(sine_zenith) < 1e-9 or abs(math.cos(latitude_radians)) < 1e-9:
        # Sun exactly overhead, or the site is at a pole: azimuth is degenerate.
        azimuth = 180.0
    else:
        cosine_azimuth = (
            math.sin(latitude_radians) * cosine_zenith - math.sin(declination_radians)
        ) / (math.cos(latitude_radians) * sine_zenith)
        cosine_azimuth = max(-1.0, min(1.0, cosine_azimuth))
        bearing_from_south = math.degrees(math.acos(cosine_azimuth))
        # NOAA convention: the acos above is measured from south, so it is
        # rotated to a compass bearing clockwise from north. Before local solar
        # noon the hour angle is negative and the Sun is east of the meridian.
        if hour_angle > 0:
            azimuth = (bearing_from_south + 180.0) % 360.0
        else:
            azimuth = (540.0 - bearing_from_south) % 360.0

    return SunPosition(altitude_degrees=altitude, azimuth_degrees=azimuth % 360.0)


def angular_separation(
    first_altitude: float,
    first_azimuth: float,
    second_altitude: float,
    second_azimuth: float,
) -> float:
    """Great-circle separation between two horizontal coordinates, in degrees."""
    lat1, lon1 = math.radians(first_altitude), math.radians(first_azimuth)
    lat2, lon2 = math.radians(second_altitude), math.radians(second_azimuth)
    cosine = math.sin(lat1) * math.sin(lat2) + math.cos(lat1) * math.cos(lat2) * math.cos(
        lon2 - lon1
    )
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


def equatorial_position(moment: datetime) -> EquatorialPosition:
    """The Sun's apparent right ascension and declination.

    Exists so the two coordinate paths can be checked against each other: convert
    this through equatorial_to_horizontal and it must land where `position()`
    independently says the Sun is. Two derivations agreeing is much stronger
    evidence than either one on its own.
    """
    century, mean_longitude, mean_anomaly, _, obliquity = _solar_elements(moment)
    apparent = math.radians(_apparent_longitude(century, mean_longitude, mean_anomaly))
    obliquity_radians = math.radians(obliquity)

    declination = math.degrees(
        math.asin(math.sin(obliquity_radians) * math.sin(apparent))
    )
    right_ascension = math.degrees(
        math.atan2(math.cos(obliquity_radians) * math.sin(apparent), math.cos(apparent))
    )
    return EquatorialPosition(
        right_ascension_hours=(right_ascension % 360.0) / 15.0,
        declination_degrees=declination,
    )
