"""Edge cases in the safety module.

These are the branches that a happy-path suite never reaches: a degenerate
sector, a survey with a single sample, a bearing that falls before the first
sample and has to wrap backwards across north, a January date in the Julian Day
conversion, a site at a pole. None of them is exotic. A compass survey with one
usable bearing is what you get on a rooftop hemmed in on three sides, and a
January date is simply winter.

This is the code that decides whether a telescope may move. Leaving a branch
untested here means shipping a rule nobody has ever seen run.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from contracts.models import CommandRejectionReason
from darkview_agent.safety.envelope import (
    SafetyEnvelope,
    azimuth_in_sector,
    horizon_minimum_altitude,
    normalise_azimuth,
)
from darkview_agent.safety.sun import SiteLocation, position
from tests.envelope_fixtures import NIGHT, TBILISI, build_config, mask_entry, sector


class Entry:
    """A horizon sample, matching the shape the contract model exposes."""

    def __init__(self, azimuth_degrees: float, min_altitude_degrees: float) -> None:
        self.azimuth_degrees = azimuth_degrees
        self.min_altitude_degrees = min_altitude_degrees


# --------------------------------------------------------------------------
# Azimuth sectors
# --------------------------------------------------------------------------


def test_a_zero_width_sector_forbids_nothing():
    """from == to is an empty sector, not a full circle.

    Reading it as a full circle would silently close the entire sky.
    """
    assert azimuth_in_sector(90.0, 90.0, 90.0) is False
    assert azimuth_in_sector(0.0, 90.0, 90.0) is False
    assert azimuth_in_sector(270.0, 90.0, 90.0) is False


def test_bearings_are_normalised_before_comparison():
    assert normalise_azimuth(370.0) == pytest.approx(10.0)
    assert normalise_azimuth(-10.0) == pytest.approx(350.0)
    assert azimuth_in_sector(370.0, 0.0, 20.0) is True
    assert azimuth_in_sector(-5.0, 350.0, 10.0) is True


# --------------------------------------------------------------------------
# Horizon mask
# --------------------------------------------------------------------------


def test_a_single_survey_sample_applies_at_every_bearing():
    """One usable bearing is what a hemmed-in rooftop gives you.

    With nothing to interpolate against, that one value is the horizon
    everywhere rather than being silently ignored.
    """
    mask = [Entry(90.0, 35.0)]
    for azimuth in (0.0, 90.0, 180.0, 270.0, 359.0):
        assert horizon_minimum_altitude(azimuth, mask) == pytest.approx(35.0)


def test_a_bearing_before_the_first_sample_wraps_back_across_north():
    """Bearing 5 sits between the 350 sample and the 10 sample, not outside the survey."""
    mask = [Entry(10.0, 20.0), Entry(180.0, 40.0), Entry(350.0, 60.0)]
    interpolated = horizon_minimum_altitude(5.0, mask)
    assert interpolated is not None
    # Three quarters of the way from 350 (60 degrees) to 10 (20 degrees).
    assert 20.0 < interpolated < 60.0
    assert interpolated == pytest.approx(30.0, abs=0.001)


def test_a_bearing_past_the_last_sample_wraps_forward_across_north():
    mask = [Entry(10.0, 20.0), Entry(350.0, 60.0)]
    interpolated = horizon_minimum_altitude(355.0, mask)
    assert interpolated is not None
    assert 20.0 < interpolated < 60.0


def test_an_exact_sample_bearing_returns_that_sample():
    mask = [Entry(0.0, 25.0), Entry(90.0, 35.0)]
    assert horizon_minimum_altitude(90.0, mask) == pytest.approx(35.0)


def test_an_empty_survey_imposes_no_constraint():
    assert horizon_minimum_altitude(123.0, []) is None


# --------------------------------------------------------------------------
# Nudge
# --------------------------------------------------------------------------


def test_a_negative_nudge_step_is_refused():
    """Direction is carried separately; a negative step is a malformed request."""
    envelope = SafetyEnvelope(config=build_config(max_altitude_degrees=70.0), site=TBILISI)
    result = envelope.evaluate_nudge(0.0, -0.05)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_nudge_limit_exceeded


def test_the_wrapper_delegates_nudge_evaluation():
    config = build_config(
        max_altitude_degrees=70.0, nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.1
    )
    envelope = SafetyEnvelope(config=config, site=TBILISI)
    assert envelope.evaluate_nudge(0.0, 0.05).permitted is True
    assert envelope.evaluate_nudge(0.49, 0.05).permitted is False


def test_the_wrapper_reports_measurement_state():
    assert SafetyEnvelope().is_measured is False
    assert SafetyEnvelope(config=build_config(max_altitude_degrees=68.0)).is_measured is True


# --------------------------------------------------------------------------
# Solar position edge cases
# --------------------------------------------------------------------------


@pytest.mark.parametrize("month", [1, 2])
def test_january_and_february_dates_use_the_shifted_julian_year(month):
    """The Julian Day conversion treats Jan and Feb as months 13 and 14 of the prior year.

    Getting this wrong shifts the date by a year and puts the Sun in the wrong
    place all winter — which is the half of the year with the longest nights and
    therefore the most observing.
    """
    solar = position(datetime(2026, month, 15, 9, 0, tzinfo=UTC), TBILISI)
    # Northern winter: the Sun is low and south at local noon.
    assert -10.0 < solar.altitude_degrees < 40.0
    assert 150.0 < solar.azimuth_degrees < 210.0


def test_winter_noon_is_lower_than_summer_noon():
    winter = position(datetime(2026, 1, 15, 9, 0, tzinfo=UTC), TBILISI)
    summer = position(datetime(2026, 7, 15, 9, 0, tzinfo=UTC), TBILISI)
    assert winter.altitude_degrees < summer.altitude_degrees


def test_hour_angle_wraps_correctly_before_local_midnight():
    """Sites far east of Greenwich push true solar time past the wrap point."""
    kiritimati = SiteLocation(1.87, -157.4)
    solar = position(datetime(2026, 6, 21, 0, 30, tzinfo=UTC), kiritimati)
    assert -90.0 <= solar.altitude_degrees <= 90.0
    assert 0.0 <= solar.azimuth_degrees < 360.0


def test_azimuth_is_defined_at_a_pole():
    """cos(latitude) approaches zero at a pole, so azimuth is degenerate.

    It must still return a usable bearing rather than dividing by zero.
    """
    north_pole = SiteLocation(90.0, 0.0)
    solar = position(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), north_pole)
    assert 0.0 <= solar.azimuth_degrees < 360.0
    # Midsummer at the pole: the Sun circles at roughly the obliquity.
    assert solar.altitude_degrees == pytest.approx(23.44, abs=0.5)


def test_the_south_pole_is_dark_at_northern_midsummer():
    south_pole = SiteLocation(-90.0, 0.0)
    solar = position(datetime(2026, 6, 21, 12, 0, tzinfo=UTC), south_pole)
    assert solar.altitude_degrees < 0.0


# --------------------------------------------------------------------------
# A refusal always explains itself
# --------------------------------------------------------------------------


def test_every_refusal_carries_a_readable_detail():
    """An operator reading a log needs to know which rule fired and by how much."""
    config = build_config(
        max_altitude_degrees=68.0,
        min_altitude_degrees=20.0,
        horizon_mask=[mask_entry(0.0, 30.0), mask_entry(180.0, 30.0)],
        forbidden_azimuth_sectors=[sector(100.0, 130.0)],
    )
    envelope = SafetyEnvelope(config=config, site=TBILISI)

    refusals = [
        envelope.evaluate_pointing(NIGHT, 10.0, 180.0),
        envelope.evaluate_pointing(NIGHT, 80.0, 180.0),
        envelope.evaluate_pointing(NIGHT, 25.0, 0.0),
        envelope.evaluate_pointing(NIGHT, 45.0, 110.0),
    ]

    for refusal in refusals:
        assert refusal.permitted is False
        assert refusal.reason is not None
        assert len(refusal.detail) > 20, f"unhelpful detail: {refusal.detail!r}"
