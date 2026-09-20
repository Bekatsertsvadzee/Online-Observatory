"""Audit probes, 2026-09-19: property-based checks on the safety code.

Needs `hypothesis`, which is not in requirements-dev.txt; the module skips
without it. Simulator and pure functions only.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest

hypothesis = pytest.importorskip("hypothesis")
from hypothesis import given, settings  # noqa: E402
from hypothesis import strategies as st  # noqa: E402

from darkview_agent.safety import sun  # noqa: E402
from darkview_agent.safety.coordinates import equatorial_to_horizontal  # noqa: E402
from darkview_agent.safety.envelope import evaluate_pointing  # noqa: E402
from tests.envelope_fixtures import TBILISI, build_config  # noqa: E402

MAX_ALT = 80.0
CONFIG = build_config(max_altitude_degrees=MAX_ALT)
BASE = datetime(2026, 1, 1, tzinfo=UTC)

moments = st.integers(min_value=0, max_value=365 * 24 * 3600).map(
    lambda s: BASE + timedelta(seconds=s)
)
altitudes = st.floats(min_value=-90.0, max_value=90.0, allow_nan=False)
azimuths = st.floats(min_value=-720.0, max_value=720.0, allow_nan=False)


@settings(max_examples=400, deadline=None)
@given(at=moments, alt=altitudes, az=azimuths)
def test_probe_nothing_above_max_alt_is_ever_permitted(at, alt, az):
    verdict = evaluate_pointing(CONFIG, TBILISI, at, alt, az)
    if alt > MAX_ALT:
        assert not verdict.permitted


@settings(max_examples=400, deadline=None)
@given(at=moments, alt=altitudes, az=azimuths)
def test_probe_nothing_inside_the_sun_exclusion_is_ever_permitted(at, alt, az):
    verdict = evaluate_pointing(CONFIG, TBILISI, at, alt, az, operator_override=True)
    solar = sun.position(at, TBILISI)
    separation = sun.angular_separation(alt, az, solar.altitude_degrees, solar.azimuth_degrees)
    if separation < CONFIG.sun_exclusion_degrees:
        assert not verdict.permitted


@settings(max_examples=400, deadline=None)
@given(
    at=moments,
    alt=st.floats(allow_nan=True, allow_infinity=True),
    az=st.floats(allow_nan=True, allow_infinity=True),
)
def test_probe_non_finite_pointing_is_refused_not_raised(at, alt, az):
    if math.isfinite(alt) and math.isfinite(az):
        return
    verdict = evaluate_pointing(CONFIG, TBILISI, at, alt, az)
    assert not verdict.permitted


@settings(max_examples=400, deadline=None)
@given(
    at=moments,
    ra=st.floats(min_value=0.0, max_value=24.0, exclude_max=True, allow_nan=False),
    dec=st.floats(min_value=-90.0, max_value=90.0, allow_nan=False),
)
def test_probe_coordinates_stay_in_range(at, ra, dec):
    horizontal = equatorial_to_horizontal(ra, dec, at, TBILISI)
    assert -90.0 <= horizontal.altitude_degrees <= 90.0
    assert 0.0 <= horizontal.azimuth_degrees < 360.0


@settings(max_examples=400, deadline=None)
@given(a1=altitudes, z1=azimuths, a2=altitudes, z2=azimuths)
def test_probe_angular_separation_is_a_metric(a1, z1, a2, z2):
    forward = sun.angular_separation(a1, z1, a2, z2)
    assert 0.0 <= forward <= 180.0
    assert math.isclose(forward, sun.angular_separation(a2, z2, a1, z1), abs_tol=1e-9)
    # A point is zero from itself, to the precision the formula has. `acos` of a
    # cosine near 1 is where double precision is worst: the cosine is computed to
    # about 1e-16 and `acos` turns that into roughly 1e-8 radians, which is 1e-6
    # degrees, or four microarcseconds. The exclusion this feeds is fifteen
    # degrees, so the margin here is ten orders of magnitude of headroom -- but
    # the property should say what is true rather than what is tidy.
    assert sun.angular_separation(a1, z1, a1, z1) < 1e-4
