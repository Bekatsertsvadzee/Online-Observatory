"""ADR-076: what `NexStarMount` and `NexStarFocuser` add beyond the conformance suite.

The conformance suite proves they keep the interfaces. These prove the parts only a
serial NexStar driver has: the pointing model, the wire format, tracking by its own
loop, and the guards a hand controller without alignment does not keep for us.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.devices.base import DeviceError, NotConnectedError
from darkview_agent.devices.nexstar import PointingModel, SyncPoint, load_model_file
from darkview_agent.safety.coordinates import (
    equatorial_to_horizontal,
    horizontal_to_equatorial,
)
from tests.fake_nexstar import (
    SITE,
    FakeNexStarPort,
    nexstar_focuser,
    nexstar_mount,
    write_model,
)


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock()


@pytest.fixture
def port(clock) -> FakeNexStarPort:
    return FakeNexStarPort(clock)


@pytest.fixture
def model(tmp_path):
    return write_model(tmp_path / "model.json")


def test_horizontal_to_equatorial_inverts_equatorial_to_horizontal():
    moment = datetime(2026, 11, 1, 20, 0, tzinfo=UTC)
    for ra, dec in [(18.6156, 38.784), (5.2423, -8.202), (2.5303, 89.0), (13.0, 10.0)]:
        here = equatorial_to_horizontal(ra, dec, moment, SITE)
        back = horizontal_to_equatorial(here.altitude_degrees, here.azimuth_degrees, moment, SITE)
        assert back[0] == pytest.approx(ra, abs=1e-6)
        assert back[1] == pytest.approx(dec, abs=1e-6)


def test_the_model_maps_sky_to_axes_with_the_fitted_offsets():
    points = [SyncPoint(110.0, 25.0, 100.0, 30.0), SyncPoint(210.0, 55.0, 200.0, 60.0)]
    model = PointingModel(points)
    assert model.sky_to_mount(45.0, 150.0) == pytest.approx((160.0, 40.0))
    assert model.mount_to_sky(160.0, 40.0) == pytest.approx((45.0, 150.0))
    assert model.residual_degrees == pytest.approx(0.0, abs=1e-9)


def test_a_reversed_axis_is_found_only_with_wide_coverage():
    # The azimuth motor counts the other way: mount az = 50 - sky az.
    sky = [(10.0, 30.0), (80.0, 45.0), (150.0, 60.0)]
    points = [SyncPoint((50.0 - az) % 360.0, alt, az, alt) for az, alt in sky]
    assert PointingModel(points).sign["az"] == -1
    assert PointingModel(points[:2]).sign["az"] == 1


def test_a_model_without_sync_points_is_refused(tmp_path, port):
    mount = nexstar_mount(port, write_model(tmp_path / "m.json", points=[]))
    with pytest.raises(DeviceError, match="no sync points"):
        mount.connect()
    with pytest.raises(DeviceError, match="not readable"):
        load_model_file(tmp_path / "missing.json")


def test_the_panels_own_file_is_read(tmp_path):
    loaded = load_model_file(
        write_model(
            tmp_path / "observatory.json",
            sign={"az": 1, "alt": 1},
            park=[12.5, 3.0],
            lat=41.7,
            custom=[],
        )
    )
    assert loaded.park == (12.5, 3.0)
    assert len(loaded.model.points) == 1


def test_rates_go_out_as_quarter_arcseconds_on_the_right_axis(port, model, clock):
    mount = nexstar_mount(port, model)
    mount.connect()
    mount.slew_to(45.0, 90.0)
    mount.tick()
    azimuth, altitude = port.rate_commands()[-2:]
    assert azimuth[:4] == bytes([80, 3, 16, 6])
    assert altitude[:4] == bytes([80, 3, 17, 6])
    assert (azimuth[4] << 8 | azimuth[5]) == int(4.0 * 3600 * 4)  # clamped at 4 deg/s


def test_a_slew_is_reported_until_the_aim_is_reached(port, model, clock):
    mount = nexstar_mount(port, model)
    mount.connect()
    mount.slew_to(30.0, 20.0)
    clock.advance(1.0)
    assert mount.status().slewing is True
    clock.advance(60.0)
    status = mount.status()
    assert status.slewing is False
    assert port.rates == {16: 0.0, 17: 0.0}


def test_tracking_follows_the_sky_after_a_slew(port, model, clock):
    start = datetime(2026, 11, 1, 20, 0, tzinfo=UTC)
    mount = nexstar_mount(port, model, now=lambda: start + timedelta(seconds=clock.monotonic()))
    mount.connect()
    mount.set_tracking(True)
    mount.slew_to(50.0, 120.0)
    clock.advance(60.0)
    mount.status()
    arrived = start + timedelta(seconds=clock.monotonic())
    held = horizontal_to_equatorial(50.0, 120.0, arrived, SITE)

    clock.advance(600.0)
    status = mount.status()
    expected = equatorial_to_horizontal(*held, start + timedelta(seconds=660.0), SITE)
    assert status.tracking is True
    assert status.slewing is False
    assert status.altitude_degrees == pytest.approx(expected.altitude_degrees, abs=0.02)
    assert status.azimuth_degrees == pytest.approx(expected.azimuth_degrees, abs=0.02)
    assert (status.altitude_degrees, status.azimuth_degrees) != pytest.approx(
        (50.0, 120.0), abs=0.5
    )


def test_tracking_off_stops_the_axes(port, model, clock):
    mount = nexstar_mount(port, model)
    mount.connect()
    mount.set_tracking(True)
    clock.advance(5.0)
    mount.status()
    mount.set_tracking(False)
    assert port.rates == {16: 0.0, 17: 0.0}
    assert mount.status().tracking is False


def test_a_mount_running_away_from_its_aim_is_stopped_and_faulted(port, model, clock):
    port.rate_sign[16] = -1  # the model's azimuth sign is wrong
    mount = nexstar_mount(port, model)
    mount.connect()
    mount.slew_to(40.0, 100.0)
    clock.advance(30.0)
    with pytest.raises(DeviceError, match="moved away"):
        mount.status()
    assert port.rates == {16: 0.0, 17: 0.0}
    # Park still answers, and clears the fault.
    port.rate_sign[16] = 1
    mount.park()
    assert mount.status().parked is True


def test_a_stopped_loop_is_a_fault_not_a_silent_slew(port, model, clock):
    mount = nexstar_mount(port, model)
    mount.connect()
    port.controller = None  # nothing ticks the driver
    mount.slew_to(40.0, 100.0)
    clock.advance(5.0)
    with pytest.raises(DeviceError, match="control loop stopped"):
        mount.status()
    assert port.rates == {16: 0.0, 17: 0.0}


def test_disconnect_halts_both_axes_and_releases_the_port(port, model, clock):
    mount = nexstar_mount(port, model)
    mount.connect()
    mount.slew_to(40.0, 100.0)
    clock.advance(0.5)
    mount.disconnect()
    assert port.rates == {16: 0.0, 17: 0.0}
    assert port.closed is True


def test_park_goes_to_the_models_park_position(tmp_path, port, clock):
    mount = nexstar_mount(port, write_model(tmp_path / "m.json", park=[200.0, 5.0]))
    mount.park()
    assert port.axes[16] % 360.0 == pytest.approx(200.0, abs=0.03)
    assert port.axes[17] == pytest.approx(5.0, abs=0.03)
    assert mount.status().parked is True


def test_a_silent_hand_controller_refuses_the_connect(port, model):
    port.silent = True
    mount = nexstar_mount(port, model)
    with pytest.raises(DeviceError, match="answered 0 of 18"):
        mount.connect()
    assert port.closed is True


def test_an_unplugged_cable_during_a_slew_faults_the_mount(port, model, clock):
    mount = nexstar_mount(port, model)
    mount.connect()
    mount.slew_to(40.0, 100.0)
    port.unplugged = True
    mount.tick()
    port.unplugged = False
    with pytest.raises(DeviceError, match="serial error"):
        mount.status()


def test_the_focuser_reports_travel_from_its_lower_limit(port, clock):
    focuser = nexstar_focuser(port)
    focuser.connect()
    status = focuser.status()
    assert status.max_position == 40000
    assert status.position == 19000
    focuser.move_to(0)
    assert port.writes[-1] == bytes([80, 4, 0x12, 0x02, 0x00, 0x03, 0xE8, 0])


def test_an_uncalibrated_focuser_is_refused(port):
    port.focus_limits = (0, 0)
    focuser = nexstar_focuser(port)
    with pytest.raises(DeviceError, match="calibrate"):
        focuser.connect()


def test_the_focuser_will_not_move_while_disconnected(port):
    with pytest.raises(NotConnectedError):
        nexstar_focuser(port).move_to(100)
