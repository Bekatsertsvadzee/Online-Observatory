"""Equatorial to horizontal conversion.

Checked against facts about the sky, and against the solar algorithm by a route
that shares none of its code. Two independent derivations of the same position
agreeing is much stronger evidence than either passing its own tests.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from darkview_agent.safety.coordinates import (
    equatorial_to_horizontal,
    greenwich_mean_sidereal_time,
    local_sidereal_time,
)
from darkview_agent.safety.sun import SiteLocation, equatorial_position, position

TBILISI = SiteLocation(41.7151, 44.8271)
SYDNEY = SiteLocation(-33.87, 151.21)

# Polaris, J2000. Within a degree of the north celestial pole.
POLARIS_RA_HOURS = 2.5303
POLARIS_DEC_DEGREES = 89.2641


def test_polaris_sits_at_the_observers_latitude_due_north():
    """The oldest navigation fact there is: the pole star's altitude is your latitude."""
    for hour in range(0, 24, 3):
        moment = datetime(2026, 6, 21, hour, tzinfo=UTC)
        polaris = equatorial_to_horizontal(
            POLARIS_RA_HOURS, POLARIS_DEC_DEGREES, moment, TBILISI
        )
        assert polaris.altitude_degrees == pytest.approx(
            TBILISI.latitude_degrees, abs=1.0
        )
        bearing_from_north = min(
            polaris.azimuth_degrees, 360.0 - polaris.azimuth_degrees
        )
        assert bearing_from_north < 2.0, f"Polaris should be north, got {polaris}"


def test_an_object_at_the_observers_declination_reaches_the_zenith():
    """A target whose declination equals the latitude passes overhead."""
    altitudes = []
    for minutes in range(0, 24 * 60, 10):
        moment = datetime(2026, 3, 20, 0, 0, tzinfo=UTC).replace(
            hour=minutes // 60, minute=minutes % 60
        )
        found = equatorial_to_horizontal(
            6.0, TBILISI.latitude_degrees, moment, TBILISI
        )
        altitudes.append(found.altitude_degrees)
    assert max(altitudes) > 89.0


def test_an_object_on_the_celestial_equator_culminates_at_ninety_minus_latitude():
    altitudes = []
    for minutes in range(0, 24 * 60, 10):
        moment = datetime(2026, 3, 20, 0, 0, tzinfo=UTC).replace(
            hour=minutes // 60, minute=minutes % 60
        )
        altitudes.append(equatorial_to_horizontal(6.0, 0.0, moment, TBILISI).altitude_degrees)

    assert max(altitudes) == pytest.approx(90.0 - TBILISI.latitude_degrees, abs=0.5)


def test_a_far_southern_object_never_rises_from_tbilisi():
    """Declination -70 is below the horizon from latitude 41.7, always.

    An object is circumpolar-invisible when its declination is below
    -(90 - latitude), which here is -48.3.
    """
    for hour in range(24):
        moment = datetime(2026, 6, 21, hour, tzinfo=UTC)
        found = equatorial_to_horizontal(12.0, -70.0, moment, TBILISI)
        assert found.altitude_degrees < 0.0


def test_the_same_object_is_up_from_the_southern_hemisphere():
    altitudes = [
        equatorial_to_horizontal(
            12.0, -70.0, datetime(2026, 6, 21, hour, tzinfo=UTC), SYDNEY
        ).altitude_degrees
        for hour in range(24)
    ]
    assert max(altitudes) > 0.0


def test_the_two_coordinate_paths_agree_on_the_sun():
    """The strongest check available: the Sun located two independent ways.

    `position()` computes altitude and azimuth from true solar time. This route
    takes the Sun's right ascension and declination and converts them through
    sidereal time. The two share no code beyond the Julian Day, so agreement is
    real evidence rather than a tautology.
    """
    worst = 0.0
    for hour in range(0, 24, 3):
        moment = datetime(2026, 6, 21, hour, tzinfo=UTC)

        direct = position(moment, TBILISI)
        equatorial = equatorial_position(moment)
        converted = equatorial_to_horizontal(
            equatorial.right_ascension_hours,
            equatorial.declination_degrees,
            moment,
            TBILISI,
        )

        altitude_gap = abs(direct.altitude_degrees - converted.altitude_degrees)
        azimuth_gap = abs(
            ((direct.azimuth_degrees - converted.azimuth_degrees + 180.0) % 360.0) - 180.0
        )
        worst = max(worst, altitude_gap, azimuth_gap)

    assert worst < 0.1, f"the two derivations disagree by {worst:.4f} degrees"


def test_the_agreement_holds_across_the_year():
    worst = 0.0
    for month in range(1, 13):
        moment = datetime(2026, month, 15, 14, tzinfo=UTC)
        direct = position(moment, TBILISI)
        equatorial = equatorial_position(moment)
        converted = equatorial_to_horizontal(
            equatorial.right_ascension_hours,
            equatorial.declination_degrees,
            moment,
            TBILISI,
        )
        worst = max(
            worst,
            abs(direct.altitude_degrees - converted.altitude_degrees),
            abs(((direct.azimuth_degrees - converted.azimuth_degrees + 180.0) % 360.0) - 180.0),
        )

    assert worst < 0.1, f"the two derivations disagree by {worst:.4f} degrees"


def test_sidereal_time_advances_by_about_361_degrees_a_day():
    """A sidereal day is about four minutes shorter than a solar day."""
    first = greenwich_mean_sidereal_time(datetime(2026, 6, 21, 0, tzinfo=UTC))
    second = greenwich_mean_sidereal_time(datetime(2026, 6, 22, 0, tzinfo=UTC))
    advance = (second - first) % 360.0
    assert advance == pytest.approx(0.9856, abs=0.01)


def test_local_sidereal_time_is_offset_by_longitude():
    moment = datetime(2026, 6, 21, 12, tzinfo=UTC)
    greenwich = greenwich_mean_sidereal_time(moment)
    local = local_sidereal_time(moment, TBILISI)
    assert (local - greenwich) % 360.0 == pytest.approx(TBILISI.longitude_degrees, abs=0.001)


def test_azimuth_is_always_a_valid_bearing():
    for hour in range(24):
        moment = datetime(2026, 6, 21, hour, tzinfo=UTC)
        for dec in (-80.0, -40.0, 0.0, 40.0, 80.0):
            found = equatorial_to_horizontal(7.5, dec, moment, TBILISI)
            assert 0.0 <= found.azimuth_degrees < 360.0
            assert -90.0 <= found.altitude_degrees <= 90.0


def test_impossible_coordinates_are_rejected():
    moment = datetime(2026, 6, 21, 12, tzinfo=UTC)
    for ra, dec in ((24.0, 0.0), (-0.1, 0.0), (0.0, 91.0), (0.0, -91.0)):
        with pytest.raises(ValueError):
            equatorial_to_horizontal(ra, dec, moment, TBILISI)


def test_conversion_is_deterministic():
    moment = datetime(2026, 6, 21, 22, tzinfo=UTC)
    first = equatorial_to_horizontal(18.0, 0.0, moment, TBILISI)
    second = equatorial_to_horizontal(18.0, 0.0, moment, TBILISI)
    assert first == second
