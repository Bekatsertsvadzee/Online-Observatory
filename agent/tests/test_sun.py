"""Solar position, checked against astronomy rather than against itself.

Every expectation here comes from a fact about the sky that holds independently
of this implementation: at local solar noon the Sun is due south from the
northern hemisphere and due north from the southern, and its noon altitude is
90 - latitude + declination. If the algorithm is wrong these fail; they cannot
pass by agreeing with a bug.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from darkview_agent.safety.sun import SiteLocation, angular_separation, position

TBILISI = SiteLocation(41.7151, 44.8271)
SYDNEY = SiteLocation(-33.87, 151.21)
QUITO = SiteLocation(0.0, -78.5)

# Tbilisi is at longitude 44.83, so local solar noon falls near 09:00 UTC.
TBILISI_SOLAR_NOON = 9
OBLIQUITY = 23.44


def test_noon_altitude_at_the_summer_solstice():
    """90 - latitude + declination, and at the solstice declination is the obliquity."""
    solar = position(datetime(2026, 6, 21, TBILISI_SOLAR_NOON, tzinfo=UTC), TBILISI)
    expected = 90.0 - TBILISI.latitude_degrees + OBLIQUITY
    assert solar.altitude_degrees == pytest.approx(expected, abs=0.3)


def test_noon_altitude_at_the_winter_solstice():
    solar = position(datetime(2026, 12, 21, TBILISI_SOLAR_NOON, tzinfo=UTC), TBILISI)
    expected = 90.0 - TBILISI.latitude_degrees - OBLIQUITY
    assert solar.altitude_degrees == pytest.approx(expected, abs=0.3)


def test_noon_altitude_at_the_equinox():
    """At the equinox declination is zero, so noon altitude is 90 - latitude."""
    solar = position(datetime(2026, 3, 20, TBILISI_SOLAR_NOON, tzinfo=UTC), TBILISI)
    assert solar.altitude_degrees == pytest.approx(90.0 - TBILISI.latitude_degrees, abs=0.4)


def test_the_sun_is_due_south_at_noon_from_the_northern_hemisphere():
    solar = position(datetime(2026, 6, 21, TBILISI_SOLAR_NOON, tzinfo=UTC), TBILISI)
    assert solar.azimuth_degrees == pytest.approx(180.0, abs=3.0)


def test_the_sun_is_due_north_at_noon_from_the_southern_hemisphere():
    """Sydney is at longitude 151.2, so solar noon falls near 02:00 UTC."""
    solar = position(datetime(2026, 6, 21, 2, tzinfo=UTC), SYDNEY)
    assert min(solar.azimuth_degrees, 360.0 - solar.azimuth_degrees) == pytest.approx(
        0.0, abs=3.0
    )
    expected = 90.0 - abs(SYDNEY.latitude_degrees) - OBLIQUITY
    assert solar.altitude_degrees == pytest.approx(expected, abs=0.3)


def test_the_sun_passes_near_the_zenith_at_the_equator_at_the_equinox():
    """Sampled across the whole day rather than at a guessed solar noon.

    Pinning the exact minute would test my time arithmetic, not the algorithm.
    The astronomical claim is that the Sun reaches the zenith at some point that
    day, so the day's maximum is what matters.

    Sampled every minute: at the equator the Sun moves 15 degrees of hour angle
    per hour, so a coarser grid can miss the zenith by more than a degree purely
    through sampling.
    """
    altitudes = [
        position(datetime(2026, 3, 20, hour, minute, tzinfo=UTC), QUITO).altitude_degrees
        for hour in range(24)
        for minute in range(60)
    ]
    assert max(altitudes) > 89.5


def test_azimuth_sweeps_east_through_south_to_west_across_the_day():
    hours = [3, 6, 9, 12, 15]
    azimuths = [
        position(datetime(2026, 6, 21, hour, tzinfo=UTC), TBILISI).azimuth_degrees
        for hour in hours
    ]
    assert azimuths == sorted(azimuths), f"azimuth should increase through the day: {azimuths}"
    assert azimuths[0] < 90.0, "morning Sun should be east of north"
    assert azimuths[-1] > 270.0, "afternoon Sun should be west of south"


def test_the_sun_is_below_the_horizon_at_local_midnight():
    solar = position(datetime(2026, 6, 21, 21, tzinfo=UTC), TBILISI)
    assert solar.altitude_degrees < 0.0


def test_position_is_pure_and_deterministic():
    moment = datetime(2026, 6, 21, 9, tzinfo=UTC)
    first = position(moment, TBILISI)
    second = position(moment, TBILISI)
    assert first == second


def test_a_naive_datetime_is_rejected():
    """Criterion 1: time is injected explicitly, and it must be unambiguous."""
    with pytest.raises(ValueError):
        position(datetime(2026, 6, 21, 9), TBILISI)


def test_equivalent_instants_in_different_timezones_agree():
    from datetime import timedelta, timezone

    utc_moment = datetime(2026, 6, 21, 9, tzinfo=UTC)
    tbilisi_moment = datetime(2026, 6, 21, 13, tzinfo=timezone(timedelta(hours=4)))
    assert position(utc_moment, TBILISI) == position(tbilisi_moment, TBILISI)


def test_impossible_coordinates_are_rejected():
    for latitude, longitude in ((91.0, 0.0), (-91.0, 0.0), (0.0, 181.0), (0.0, -181.0)):
        with pytest.raises(ValueError):
            SiteLocation(latitude, longitude)


def test_angular_separation_of_a_point_with_itself_is_zero():
    assert angular_separation(45.0, 180.0, 45.0, 180.0) == pytest.approx(0.0, abs=1e-6)


def test_angular_separation_along_a_meridian_equals_the_altitude_difference():
    assert angular_separation(30.0, 180.0, 60.0, 180.0) == pytest.approx(30.0, abs=1e-6)


def test_azimuth_separation_shrinks_toward_the_zenith():
    """The reason Sun-exclusion tests must vary altitude, not azimuth.

    Ninety degrees of azimuth is ninety degrees of sky at the horizon, but very
    little of it directly overhead.
    """
    at_horizon = angular_separation(0.0, 0.0, 0.0, 90.0)
    near_zenith = angular_separation(85.0, 0.0, 85.0, 90.0)
    assert at_horizon == pytest.approx(90.0, abs=1e-6)
    assert near_zenith < 10.0
