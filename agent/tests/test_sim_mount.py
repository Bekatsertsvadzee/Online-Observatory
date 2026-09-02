import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.devices.simulated import (
    SLEW_RATE_DEGREES_PER_SECOND,
    SLEW_SETTLE_SECONDS,
    SimMount,
)


def connected_mount(clock: ManualClock) -> SimMount:
    mount = SimMount(clock=clock)
    mount.connect()
    mount.unpark()
    return mount


def test_slew_duration_is_proportional_to_angular_distance():
    """Criterion 2: a longer slew takes longer, in proportion."""
    clock = ManualClock()
    mount = connected_mount(clock)

    # From the park position, a 40-degree move in altitude.
    mount.slew_to(40.0, 0.0)
    expected = 40.0 / SLEW_RATE_DEGREES_PER_SECOND + SLEW_SETTLE_SECONDS

    clock.advance(expected - 0.1)
    assert mount.status().slewing is True, "arrived early"

    clock.advance(0.2)
    assert mount.status().slewing is False, "did not arrive on time"


def test_a_longer_slew_takes_longer_than_a_shorter_one():
    short_clock, long_clock = ManualClock(), ManualClock()
    short, long = connected_mount(short_clock), connected_mount(long_clock)

    short.slew_to(10.0, 0.0)
    long.slew_to(80.0, 0.0)

    # A time that finishes the short slew but not the long one.
    short_clock.advance(10.0)
    long_clock.advance(10.0)

    assert short.status().slewing is False
    assert long.status().slewing is True


def test_slew_can_be_aborted_mid_flight_and_reports_not_slewing():
    """Criterion 2, the part that matters for safety."""
    clock = ManualClock()
    mount = connected_mount(clock)
    mount.slew_to(80.0, 0.0)

    clock.advance(4.0)
    in_flight = mount.status()
    assert in_flight.slewing is True
    assert 0.0 < in_flight.altitude_degrees < 80.0

    mount.abort_slew()

    stopped = mount.status()
    assert stopped.slewing is False
    # It stopped where it was, not at the target and not back at the start.
    assert stopped.altitude_degrees == pytest.approx(in_flight.altitude_degrees, abs=0.001)
    assert stopped.altitude_degrees < 80.0


def test_position_advances_smoothly_rather_than_jumping():
    clock = ManualClock()
    mount = connected_mount(clock)
    mount.slew_to(60.0, 0.0)

    readings = []
    for _ in range(5):
        clock.advance(1.0)
        readings.append(mount.status().altitude_degrees)

    assert readings == sorted(readings), "altitude should increase monotonically"
    assert len(set(readings)) == len(readings), "position should change each second"


def test_azimuth_change_near_the_zenith_is_a_short_slew():
    """Great-circle separation, not naive difference.

    At 89 degrees altitude a 180-degree azimuth change is a small physical
    movement. A mount using the raw difference would report a huge slew time.
    """
    clock = ManualClock()
    mount = connected_mount(clock)
    mount.slew_to(89.0, 0.0)
    clock.advance(600.0)

    mount.slew_to(89.0, 180.0)
    clock.advance(SLEW_SETTLE_SECONDS + 2.0 / SLEW_RATE_DEGREES_PER_SECOND + 0.5)

    assert mount.status().slewing is False


def test_a_new_slew_starts_from_the_current_position_not_the_previous_target():
    """Re-targeting mid-slew measures distance from where the mount actually is.

    Interrupt an 80-degree slew after 2 seconds — it has reached roughly 7 degrees
    — then command 10 degrees. That is a ~3-degree move and finishes quickly. A
    mount that measured from the abandoned 80-degree target would compute a
    70-degree move and still be slewing.
    """
    clock = ManualClock()
    mount = connected_mount(clock)

    mount.slew_to(80.0, 0.0)
    clock.advance(2.0)
    interrupted_at = mount.status().altitude_degrees
    assert 5.0 < interrupted_at < 10.0, "test premise: interrupted well short of target"

    mount.slew_to(10.0, 0.0)
    remaining = abs(10.0 - interrupted_at)
    clock.advance(remaining / SLEW_RATE_DEGREES_PER_SECOND + SLEW_SETTLE_SECONDS + 0.01)

    status = mount.status()
    assert status.slewing is False, "slew was measured from the abandoned target"
    assert status.altitude_degrees == pytest.approx(10.0, abs=0.01)


def test_slewing_clears_the_parked_flag():
    clock = ManualClock()
    mount = SimMount(clock=clock)
    mount.connect()
    assert mount.status().parked is True

    mount.slew_to(30.0, 45.0)
    assert mount.status().parked is False


def test_disconnect_stops_motion():
    clock = ManualClock()
    mount = connected_mount(clock)
    mount.slew_to(80.0, 0.0)
    clock.advance(1.0)

    mount.disconnect()
    assert mount.status().slewing is False
