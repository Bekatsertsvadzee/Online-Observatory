"""Equatorial to horizontal coordinates.

A GOTO carries J2000 right ascension and declination. The safety envelope works
in altitude and azimuth, because that is what the fork base, the horizon and the
Sun care about. The conversion happens here, inside the agent — the contract is
explicit that it never happens in a client.

Pure, like everything else in this package. Time is passed in.

On precision: J2000 coordinates are treated as apparent. Precession between J2000
and now is roughly a third of a degree, which is immaterial against a Sun
exclusion measured in tens of degrees and a horizon mask surveyed by compass. It
would matter for pointing accuracy, and that is what plate solving in DV-030 is
for — the envelope's job is to answer "is this direction allowed", not to place
a target on a pixel.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

from darkview_agent.safety.sun import SiteLocation, _julian_day


@dataclass(frozen=True)
class HorizontalPosition:
    altitude_degrees: float
    azimuth_degrees: float


def greenwich_mean_sidereal_time(moment: datetime) -> float:
    """GMST in degrees.

    Sidereal time is what turns a fixed direction in the sky into a direction
    above a particular patch of ground, so it is the whole of the conversion.
    """
    julian_day = _julian_day(moment)
    days_since_epoch = julian_day - 2451545.0
    century = days_since_epoch / 36525.0

    gmst = (
        280.46061837
        + 360.98564736629 * days_since_epoch
        + 0.000387933 * century**2
        - century**3 / 38710000.0
    )
    return gmst % 360.0


def local_sidereal_time(moment: datetime, site: SiteLocation) -> float:
    """LST in degrees, east longitude positive."""
    return (greenwich_mean_sidereal_time(moment) + site.longitude_degrees) % 360.0


def equatorial_to_horizontal(
    right_ascension_hours: float,
    declination_degrees: float,
    moment: datetime,
    site: SiteLocation,
) -> HorizontalPosition:
    """Where a catalogue position is in this sky, now.

    Azimuth is measured clockwise from north, matching the mount, the horizon
    mask and the Sun calculation.
    """
    if not 0.0 <= right_ascension_hours < 24.0:
        raise ValueError("right ascension must be within 0..24 hours")
    if not -90.0 <= declination_degrees <= 90.0:
        raise ValueError("declination must be within -90..90 degrees")

    right_ascension_degrees = right_ascension_hours * 15.0
    hour_angle = math.radians(
        (local_sidereal_time(moment, site) - right_ascension_degrees) % 360.0
    )

    declination = math.radians(declination_degrees)
    latitude = math.radians(site.latitude_degrees)

    sine_altitude = math.sin(declination) * math.sin(latitude) + math.cos(
        declination
    ) * math.cos(latitude) * math.cos(hour_angle)
    altitude = math.degrees(math.asin(max(-1.0, min(1.0, sine_altitude))))

    azimuth = math.degrees(
        math.atan2(
            -math.sin(hour_angle) * math.cos(declination),
            math.sin(declination) * math.cos(latitude)
            - math.cos(declination) * math.sin(latitude) * math.cos(hour_angle),
        )
    )

    return HorizontalPosition(
        altitude_degrees=altitude,
        azimuth_degrees=azimuth % 360.0,
    )
