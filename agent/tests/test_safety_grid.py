"""DV-023 acceptance criterion 2: walk the whole sky in 1-degree steps.

Every altitude-azimuth cell is evaluated and compared against an expected mask
computed independently of the envelope. The point is not to re-run the same code
twice — the expectation here is written from the rules as stated in prose, so a
mistake in the envelope shows up as a disagreement rather than being reproduced
on both sides.

91 altitudes x 360 azimuths = 32,760 cells.
"""

from __future__ import annotations

from contracts.models import CommandRejectionReason
from darkview_agent.safety import sun
from darkview_agent.safety.envelope import evaluate_pointing
from tests.envelope_fixtures import NIGHT, TBILISI, build_config, mask_entry, sector

MIN_ALTITUDE = 20.0
MAX_ALTITUDE = 68.0
SUN_EXCLUSION = 30.0

CONFIG = build_config(
    max_altitude_degrees=MAX_ALTITUDE,
    min_altitude_degrees=MIN_ALTITUDE,
    horizon_mask=[
        mask_entry(0.0, 25.0),
        mask_entry(90.0, 35.0),
        mask_entry(180.0, 25.0),
        mask_entry(270.0, 30.0),
    ],
    forbidden_azimuth_sectors=[sector(100.0, 130.0), sector(350.0, 10.0)],
    sun_exclusion_degrees=SUN_EXCLUSION,
    daylight_lock_sun_altitude_degrees=-12.0,
)


def expected_horizon_minimum(azimuth: float) -> float:
    """The surveyed horizon, interpolated by hand from the four samples above."""
    samples = [(0.0, 25.0), (90.0, 35.0), (180.0, 25.0), (270.0, 30.0), (360.0, 25.0)]
    for index in range(len(samples) - 1):
        left_azimuth, left_altitude = samples[index]
        right_azimuth, right_altitude = samples[index + 1]
        if left_azimuth <= azimuth <= right_azimuth:
            span = right_azimuth - left_azimuth
            fraction = (azimuth - left_azimuth) / span
            return left_altitude + (right_altitude - left_altitude) * fraction
    raise AssertionError(f"azimuth {azimuth} outside 0..360")


def expected_reason(altitude: float, azimuth: float, solar) -> CommandRejectionReason | None:
    """The rules, restated in the order the envelope applies them."""
    separation = sun.angular_separation(
        altitude, azimuth, solar.altitude_degrees, solar.azimuth_degrees
    )
    if separation < SUN_EXCLUSION:
        return CommandRejectionReason.safety_sun_exclusion
    if solar.altitude_degrees > -12.0:
        return CommandRejectionReason.safety_daylight_lock
    if altitude < MIN_ALTITUDE:
        return CommandRejectionReason.safety_below_min_altitude
    if altitude > MAX_ALTITUDE:
        return CommandRejectionReason.safety_above_max_altitude
    if altitude < expected_horizon_minimum(azimuth):
        return CommandRejectionReason.safety_horizon_mask
    in_forbidden = (100.0 <= azimuth < 130.0) or (azimuth >= 350.0 or azimuth < 10.0)
    if in_forbidden:
        return CommandRejectionReason.safety_forbidden_azimuth
    return None


def test_the_whole_sky_matches_the_expected_mask():
    solar = sun.position(NIGHT, TBILISI)
    disagreements: list[str] = []
    permitted_cells = 0

    for altitude in range(0, 91):
        for azimuth in range(0, 360):
            result = evaluate_pointing(
                CONFIG, TBILISI, NIGHT, float(altitude), float(azimuth)
            )
            expected = expected_reason(float(altitude), float(azimuth), solar)

            if result.reason is not expected:
                disagreements.append(
                    f"alt={altitude} az={azimuth}: envelope={result.reason} expected={expected}"
                )
            if result.permitted:
                permitted_cells += 1

    assert not disagreements, (
        f"{len(disagreements)} of 32760 cells disagreed with the expected mask:\n  "
        + "\n  ".join(disagreements[:15])
    )
    # Sanity: the mask must neither open the whole sky nor close it.
    assert permitted_cells > 0, "the envelope refused the entire sky"
    assert permitted_cells < 91 * 360, "the envelope permitted the entire sky"


def test_the_grid_covers_every_rejection_reason_the_envelope_can_produce():
    """A grid that never triggers a rule proves nothing about that rule."""
    solar = sun.position(NIGHT, TBILISI)
    seen = set()

    for altitude in range(0, 91):
        for azimuth in range(0, 360):
            result = evaluate_pointing(
                CONFIG, TBILISI, NIGHT, float(altitude), float(azimuth)
            )
            if result.reason is not None:
                seen.add(result.reason)

    assert solar.altitude_degrees < -12.0, "fixture must be night for this to be meaningful"
    assert CommandRejectionReason.safety_below_min_altitude in seen
    assert CommandRejectionReason.safety_above_max_altitude in seen
    assert CommandRejectionReason.safety_horizon_mask in seen
    assert CommandRejectionReason.safety_forbidden_azimuth in seen


def test_unmeasured_closes_the_entire_grid():
    """Criterion 4 across the whole sky, not just a sampled point."""
    unmeasured = build_config(max_altitude_degrees=None)

    for altitude in range(0, 91, 5):
        for azimuth in range(0, 360, 5):
            result = evaluate_pointing(
                unmeasured, TBILISI, NIGHT, float(altitude), float(azimuth)
            )
            assert result.permitted is False
            assert result.reason is CommandRejectionReason.safety_envelope_unmeasured
