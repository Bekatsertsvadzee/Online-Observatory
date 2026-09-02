"""DV-023 boundary pairs — acceptance criterion 3.

For every boundary the envelope enforces there is a pair: one just inside, which
must be permitted, and one just outside, which must be refused with a specific
CommandRejectionReason. A boundary tested only from one side is a boundary that
can silently move.
"""

from __future__ import annotations

import pytest

from contracts.models import CommandRejectionReason, SafetyEnvelopeConfig
from darkview_agent.safety.envelope import (
    SafetyEnvelope,
    evaluate_nudge,
    evaluate_pointing,
    is_measured,
)
from tests.envelope_fixtures import (
    NIGHT,
    NOON,
    TBILISI,
    build_config,
    mask_entry,
    sector,
)

EPSILON = 0.01


def verdict(config, altitude, azimuth, at_time=NIGHT, site=TBILISI, override=False):
    return evaluate_pointing(config, site, at_time, altitude, azimuth, override)


# --------------------------------------------------------------------------
# Criterion 4 — UNMEASURED refuses everything, regardless of coordinates
# --------------------------------------------------------------------------


def test_no_config_is_unmeasured():
    assert is_measured(None) is False


def test_null_max_altitude_loads_and_is_unmeasured():
    config = build_config(max_altitude_degrees=None)
    assert config.max_altitude_degrees is None
    assert is_measured(config) is False


@pytest.mark.parametrize(
    ("altitude", "azimuth"),
    [(45.0, 180.0), (0.0, 0.0), (89.0, 359.0), (20.0, 90.0), (-10.0, 45.0)],
)
def test_unmeasured_refuses_every_pointing_whatever_the_coordinates(altitude, azimuth):
    """Criterion 4: regardless of coordinates."""
    result = verdict(build_config(max_altitude_degrees=None), altitude, azimuth)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_envelope_unmeasured


def test_unmeasured_refuses_a_nudge_too():
    result = evaluate_nudge(build_config(max_altitude_degrees=None), 0.0, 0.01)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_envelope_unmeasured


def test_unmeasured_outranks_every_other_violation():
    """A pointing that breaks several rules still reports UNMEASURED first.

    The most fundamental fact is that this system has never been measured.
    """
    config = build_config(max_altitude_degrees=None, min_altitude_degrees=20.0)
    result = verdict(config, -30.0, 0.0, at_time=NOON)
    assert result.reason is CommandRejectionReason.safety_envelope_unmeasured


# --------------------------------------------------------------------------
# Boundary pair — minimum altitude
# --------------------------------------------------------------------------


def test_just_above_minimum_altitude_is_permitted():
    config = build_config(max_altitude_degrees=70.0, min_altitude_degrees=20.0)
    assert verdict(config, 20.0 + EPSILON, 180.0).permitted is True


def test_exactly_at_minimum_altitude_is_permitted():
    """The minimum is inclusive: 'below this' means strictly below."""
    config = build_config(max_altitude_degrees=70.0, min_altitude_degrees=20.0)
    assert verdict(config, 20.0, 180.0).permitted is True


def test_just_below_minimum_altitude_is_refused():
    config = build_config(max_altitude_degrees=70.0, min_altitude_degrees=20.0)
    result = verdict(config, 20.0 - EPSILON, 180.0)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_below_min_altitude


# --------------------------------------------------------------------------
# Boundary pair — maximum altitude (MAX_ALT_SAFE)
# --------------------------------------------------------------------------


def test_just_below_max_altitude_is_permitted():
    config = build_config(max_altitude_degrees=68.0)
    assert verdict(config, 68.0 - EPSILON, 180.0).permitted is True


def test_exactly_at_max_altitude_is_permitted():
    config = build_config(max_altitude_degrees=68.0)
    assert verdict(config, 68.0, 180.0).permitted is True


def test_just_above_max_altitude_is_refused():
    """Above MAX_ALT_SAFE the camera train loses clearance against the fork base."""
    config = build_config(max_altitude_degrees=68.0)
    result = verdict(config, 68.0 + EPSILON, 180.0)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_above_max_altitude


# --------------------------------------------------------------------------
# Boundary pair — horizon mask
# --------------------------------------------------------------------------


def test_just_above_the_surveyed_horizon_is_permitted():
    config = build_config(
        max_altitude_degrees=80.0,
        min_altitude_degrees=5.0,
        horizon_mask=[mask_entry(0.0, 30.0), mask_entry(180.0, 30.0)],
    )
    assert verdict(config, 30.0 + EPSILON, 0.0).permitted is True


def test_just_below_the_surveyed_horizon_is_refused():
    config = build_config(
        max_altitude_degrees=80.0,
        min_altitude_degrees=5.0,
        horizon_mask=[mask_entry(0.0, 30.0), mask_entry(180.0, 30.0)],
    )
    result = verdict(config, 30.0 - EPSILON, 0.0)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_horizon_mask


def test_horizon_mask_interpolates_between_surveyed_bearings():
    """A building at one bearing shades the bearings beside it, proportionally."""
    config = build_config(
        max_altitude_degrees=80.0,
        min_altitude_degrees=5.0,
        horizon_mask=[mask_entry(0.0, 10.0), mask_entry(90.0, 50.0)],
    )
    # Midway between the 10 and 50 samples the surveyed horizon is 30.
    assert verdict(config, 29.0, 45.0).reason is CommandRejectionReason.safety_horizon_mask
    assert verdict(config, 31.0, 45.0).permitted is True
    # A quarter of the way along, the horizon is 20.
    assert verdict(config, 19.0, 22.5).reason is CommandRejectionReason.safety_horizon_mask
    assert verdict(config, 21.0, 22.5).permitted is True


def test_horizon_mask_wraps_across_north():
    """Bearing 350 sits between the 270 and 10 samples, not outside the survey."""
    config = build_config(
        max_altitude_degrees=80.0,
        min_altitude_degrees=5.0,
        horizon_mask=[mask_entry(10.0, 40.0), mask_entry(270.0, 40.0)],
    )
    result = verdict(config, 20.0, 350.0)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_horizon_mask


def test_no_survey_means_the_mask_imposes_nothing():
    config = build_config(max_altitude_degrees=80.0, min_altitude_degrees=5.0, horizon_mask=[])
    assert verdict(config, 6.0, 123.0).permitted is True


# --------------------------------------------------------------------------
# Boundary pair — forbidden azimuth sectors
# --------------------------------------------------------------------------


def test_just_outside_a_forbidden_sector_is_permitted():
    config = build_config(
        max_altitude_degrees=80.0, forbidden_azimuth_sectors=[sector(90.0, 120.0)]
    )
    assert verdict(config, 45.0, 90.0 - EPSILON).permitted is True


def test_at_the_sector_start_is_refused():
    """Inclusive start."""
    config = build_config(
        max_altitude_degrees=80.0, forbidden_azimuth_sectors=[sector(90.0, 120.0)]
    )
    result = verdict(config, 45.0, 90.0)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_forbidden_azimuth


def test_at_the_sector_end_is_permitted():
    """Exclusive end."""
    config = build_config(
        max_altitude_degrees=80.0, forbidden_azimuth_sectors=[sector(90.0, 120.0)]
    )
    assert verdict(config, 45.0, 120.0).permitted is True


def test_just_inside_the_sector_end_is_refused():
    config = build_config(
        max_altitude_degrees=80.0, forbidden_azimuth_sectors=[sector(90.0, 120.0)]
    )
    result = verdict(config, 45.0, 120.0 - EPSILON)
    assert result.reason is CommandRejectionReason.safety_forbidden_azimuth


def test_a_sector_wrapping_through_north_is_enforced_on_both_sides():
    """350..10 is a 20-degree sector across north, not a 340-degree one."""
    config = build_config(
        max_altitude_degrees=80.0, forbidden_azimuth_sectors=[sector(350.0, 10.0)]
    )
    assert verdict(config, 45.0, 355.0).reason is CommandRejectionReason.safety_forbidden_azimuth
    assert verdict(config, 45.0, 5.0).reason is CommandRejectionReason.safety_forbidden_azimuth
    assert verdict(config, 45.0, 180.0).permitted is True
    assert verdict(config, 45.0, 11.0).permitted is True


# --------------------------------------------------------------------------
# Boundary pair — Sun exclusion (criterion 5: never bypassable)
# --------------------------------------------------------------------------


def sun_position_at(moment=NOON):
    from darkview_agent.safety import sun

    return sun.position(moment, TBILISI)


def sun_exclusion_config():
    return build_config(
        max_altitude_degrees=89.0,
        min_altitude_degrees=0.0,
        sun_exclusion_degrees=30.0,
        daylight_lock_sun_altitude_degrees=90.0,  # lock disabled, isolate the Sun rule
    )


def test_just_outside_the_sun_exclusion_is_permitted():
    """Separation is varied in altitude, which maps one-to-one onto angular distance.

    Varying azimuth would not: at the Sun's noon altitude of ~72 degrees, a
    45-degree azimuth offset is only about 14 degrees of actual separation. That
    convergence toward the zenith is exactly what the great-circle calculation
    exists to handle, and a test that ignored it would assert the wrong thing.
    """
    solar = sun_position_at()
    result = verdict(
        config=sun_exclusion_config(),
        altitude=solar.altitude_degrees - 31.0,
        azimuth=solar.azimuth_degrees,
        at_time=NOON,
    )
    assert result.permitted is True


def test_just_inside_the_sun_exclusion_is_refused():
    solar = sun_position_at()
    result = verdict(
        config=sun_exclusion_config(),
        altitude=solar.altitude_degrees - 29.0,
        azimuth=solar.azimuth_degrees,
        at_time=NOON,
    )
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_sun_exclusion


def test_pointing_straight_at_the_sun_is_refused():
    solar = sun_position_at()
    config = build_config(
        max_altitude_degrees=89.0, min_altitude_degrees=0.0, sun_exclusion_degrees=30.0
    )
    result = verdict(config, solar.altitude_degrees, solar.azimuth_degrees, at_time=NOON)
    assert result.reason is CommandRejectionReason.safety_sun_exclusion


def test_operator_override_does_not_bypass_the_sun_exclusion():
    """Criterion 5. The override exists for terrestrial testing, not for the Sun."""
    solar = sun_position_at()
    config = build_config(
        max_altitude_degrees=89.0, min_altitude_degrees=0.0, sun_exclusion_degrees=30.0
    )
    result = verdict(
        config,
        solar.altitude_degrees,
        solar.azimuth_degrees,
        at_time=NOON,
        override=True,
    )
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_sun_exclusion


def test_the_sun_exclusion_cannot_be_configured_to_zero_and_ignored():
    """Even a zero exclusion still refuses pointing exactly at the Sun's centre.

    A zero configuration is the widest the exclusion can be made, and it is still
    not a bypass: it merely shrinks the margin, and the Sun itself stays refused
    by the daylight lock that a zero exclusion leaves in force.
    """
    solar = sun_position_at()
    config = build_config(
        max_altitude_degrees=89.0,
        min_altitude_degrees=0.0,
        sun_exclusion_degrees=0.0,
        daylight_lock_sun_altitude_degrees=-12.0,
    )
    result = verdict(config, solar.altitude_degrees, solar.azimuth_degrees, at_time=NOON)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_daylight_lock


def test_an_unknown_site_refuses_rather_than_assuming_the_sun_is_elsewhere():
    """Fail closed. Sun avoidance is never assumed."""
    config = build_config(max_altitude_degrees=80.0)
    result = evaluate_pointing(config, None, NIGHT, 45.0, 180.0)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_sun_exclusion


# --------------------------------------------------------------------------
# Boundary pair — daylight lock
# --------------------------------------------------------------------------


def test_below_the_daylight_lock_is_permitted():
    config = build_config(max_altitude_degrees=80.0, daylight_lock_sun_altitude_degrees=-12.0)
    # At NIGHT the Sun is far below -12.
    assert verdict(config, 45.0, 180.0, at_time=NIGHT).permitted is True


def test_above_the_daylight_lock_is_refused():
    config = build_config(
        max_altitude_degrees=89.0,
        min_altitude_degrees=0.0,
        sun_exclusion_degrees=1.0,
        daylight_lock_sun_altitude_degrees=-12.0,
    )
    # Point well away from the Sun so only the daylight lock can fire.
    solar = sun_position_at()
    result = verdict(
        config, 10.0, (solar.azimuth_degrees + 180.0) % 360.0, at_time=NOON
    )
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_daylight_lock


def test_operator_override_lifts_the_daylight_lock():
    """Permitted for attended terrestrial testing, and still Sun-bounded."""
    config = build_config(
        max_altitude_degrees=89.0,
        min_altitude_degrees=0.0,
        sun_exclusion_degrees=1.0,
        daylight_lock_sun_altitude_degrees=-12.0,
    )
    solar = sun_position_at()
    result = verdict(
        config,
        10.0,
        (solar.azimuth_degrees + 180.0) % 360.0,
        at_time=NOON,
        override=True,
    )
    assert result.permitted is True


# --------------------------------------------------------------------------
# Boundary pair — nudge limits
# --------------------------------------------------------------------------


def test_a_nudge_within_the_cumulative_limit_is_permitted():
    config = build_config(
        max_altitude_degrees=70.0, nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.1
    )
    assert evaluate_nudge(config, 0.35, 0.1).permitted is True


def test_a_nudge_exactly_at_the_cumulative_limit_is_permitted():
    config = build_config(
        max_altitude_degrees=70.0, nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.1
    )
    assert evaluate_nudge(config, 0.4, 0.1).permitted is True


def test_a_nudge_beyond_the_cumulative_limit_is_refused():
    config = build_config(
        max_altitude_degrees=70.0, nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.1
    )
    result = evaluate_nudge(config, 0.45, 0.1)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_nudge_limit_exceeded


def test_a_step_exactly_at_the_permitted_size_is_allowed():
    config = build_config(
        max_altitude_degrees=70.0, nudge_max_degrees=5.0, nudge_rate_degrees_per_second=0.1
    )
    assert evaluate_nudge(config, 0.0, 0.1).permitted is True


def test_a_step_larger_than_permitted_is_refused():
    config = build_config(
        max_altitude_degrees=70.0, nudge_max_degrees=5.0, nudge_rate_degrees_per_second=0.1
    )
    result = evaluate_nudge(config, 0.0, 0.1 + EPSILON)
    assert result.permitted is False
    assert result.reason is CommandRejectionReason.safety_slew_rate


def test_the_cumulative_limit_counts_offsets_in_either_direction():
    config = build_config(
        max_altitude_degrees=70.0, nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.1
    )
    assert evaluate_nudge(config, -0.45, 0.1).reason is (
        CommandRejectionReason.safety_nudge_limit_exceeded
    )


# --------------------------------------------------------------------------
# Purity — criterion 1
# --------------------------------------------------------------------------


def test_evaluation_is_deterministic_for_the_same_inputs():
    config = build_config(max_altitude_degrees=70.0)
    first = verdict(config, 45.0, 180.0)
    second = verdict(config, 45.0, 180.0)
    assert (first.permitted, first.reason) == (second.permitted, second.reason)


def test_evaluation_depends_on_the_injected_time_not_the_wall_clock():
    """The same pointing is permitted at night and refused at noon."""
    config = build_config(max_altitude_degrees=89.0, min_altitude_degrees=0.0)
    solar = sun_position_at()
    azimuth = (solar.azimuth_degrees + 180.0) % 360.0

    assert verdict(config, 40.0, azimuth, at_time=NIGHT).permitted is True
    assert verdict(config, 40.0, azimuth, at_time=NOON).permitted is False


def test_a_permitted_verdict_cannot_carry_a_reason():
    from darkview_agent.safety.envelope import Verdict

    with pytest.raises(ValueError):
        Verdict(permitted=True, reason=CommandRejectionReason.safety_horizon_mask)


def test_a_refusal_must_name_a_reason():
    from darkview_agent.safety.envelope import Verdict

    with pytest.raises(ValueError):
        Verdict(permitted=False)


# --------------------------------------------------------------------------
# The wrapper carries no rules of its own
# --------------------------------------------------------------------------


def test_wrapper_matches_the_pure_functions():
    config = build_config(max_altitude_degrees=68.0)
    envelope = SafetyEnvelope(config=config, site=TBILISI)

    wrapped = envelope.evaluate_pointing(NIGHT, 70.0, 180.0)
    direct = evaluate_pointing(config, TBILISI, NIGHT, 70.0, 180.0)
    assert (wrapped.permitted, wrapped.reason) == (direct.permitted, direct.reason)


def test_contract_models_are_imported_not_redefined():
    """Criterion 6 of DV-020, still true."""
    assert SafetyEnvelopeConfig.__module__ == "contracts.models"
    assert CommandRejectionReason.__module__ == "contracts.models"
