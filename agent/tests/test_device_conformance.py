"""Shared conformance suite — acceptance criterion 1 of DV-022.

Every driver implementation runs through these, simulated and real alike. When
DV-028 adds AlpacaMount, DV-029 adds ZwoCamera and DV-031 adds the real focuser,
they are registered below and must pass the same tests without modification.

That is the point of the suite: an interface enforced only by the simulator is
not an interface, it is a description of the simulator.
"""

from __future__ import annotations

import pytest

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.clock import ManualClock
from darkview_agent.devices.base import (
    CameraDriver,
    FocuserDriver,
    MountDriver,
    NotConnectedError,
)
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount


# Registries. Real implementations join these as they are written; nothing else
# in this file changes when they do.
def mount_implementations():
    return [("SimMount", lambda clock: SimMount(clock=clock))]


def camera_implementations():
    return [("SimCamera", lambda clock: SimCamera(clock=clock))]


def focuser_implementations():
    return [("SimFocuser", lambda clock: SimFocuser(clock=clock))]


def _ids(implementations):
    return [name for name, _ in implementations]


def _factories(implementations):
    return [factory for _, factory in implementations]


ALL_IMPLEMENTATIONS = (
    mount_implementations() + camera_implementations() + focuser_implementations()
)

every_device = pytest.mark.parametrize(
    "factory", _factories(ALL_IMPLEMENTATIONS), ids=_ids(ALL_IMPLEMENTATIONS)
)
every_mount = pytest.mark.parametrize(
    "factory", _factories(mount_implementations()), ids=_ids(mount_implementations())
)
every_camera = pytest.mark.parametrize(
    "factory", _factories(camera_implementations()), ids=_ids(camera_implementations())
)
every_focuser = pytest.mark.parametrize(
    "factory", _factories(focuser_implementations()), ids=_ids(focuser_implementations())
)


# --------------------------------------------------------------------------
# Every device
# --------------------------------------------------------------------------


@every_device
def test_device_reports_a_mode(factory):
    """Criterion 4: every device declares SIMULATED or REAL, and its status carries it."""
    device = factory(ManualClock())
    assert isinstance(device.mode, ObservatoryMode)
    device.connect()
    assert device.status().mode is device.mode


@every_device
def test_connect_and_disconnect_are_reflected_in_status(factory):
    device = factory(ManualClock())
    assert device.status().connected is False
    assert device.status().health is DeviceHealth.disconnected

    device.connect()
    assert device.status().connected is True
    assert device.status().health is DeviceHealth.ok

    device.disconnect()
    assert device.status().connected is False


@every_device
def test_connect_is_idempotent(factory):
    device = factory(ManualClock())
    device.connect()
    device.connect()
    assert device.status().connected is True


# --------------------------------------------------------------------------
# Mounts
# --------------------------------------------------------------------------


@every_mount
def test_mount_satisfies_the_interface(factory):
    assert isinstance(factory(ManualClock()), MountDriver)


@every_mount
def test_mount_refuses_to_slew_while_disconnected(factory):
    mount = factory(ManualClock())
    with pytest.raises(NotConnectedError):
        mount.slew_to(45.0, 90.0)


@every_mount
def test_mount_reaches_the_commanded_position(factory):
    clock = ManualClock()
    mount = factory(clock)
    mount.connect()
    mount.unpark()

    mount.slew_to(45.0, 90.0)
    clock.advance(600.0)

    status = mount.status()
    assert status.slewing is False
    assert status.altitude_degrees == pytest.approx(45.0, abs=0.01)
    assert status.azimuth_degrees == pytest.approx(90.0, abs=0.01)


@every_mount
def test_park_is_available_even_while_slewing(factory):
    """Park is the recovery action. It must never depend on a quiet mount."""
    clock = ManualClock()
    mount = factory(clock)
    mount.connect()
    mount.unpark()
    mount.slew_to(70.0, 180.0)
    clock.advance(1.0)

    mount.park()

    status = mount.status()
    assert status.slewing is False
    assert status.parked is True
    assert status.tracking is False


@every_mount
def test_abort_is_safe_when_not_slewing(factory):
    mount = factory(ManualClock())
    mount.connect()
    mount.abort_slew()
    assert mount.status().slewing is False


@every_mount
def test_mount_will_not_track_while_parked(factory):
    mount = factory(ManualClock())
    mount.connect()
    mount.park()
    with pytest.raises(NotConnectedError):
        mount.set_tracking(True)


# --------------------------------------------------------------------------
# Cameras
# --------------------------------------------------------------------------


@every_camera
def test_camera_satisfies_the_interface(factory):
    assert isinstance(factory(ManualClock()), CameraDriver)


@every_camera
def test_camera_refuses_to_expose_while_disconnected(factory):
    camera = factory(ManualClock())
    with pytest.raises(NotConnectedError):
        camera.expose(500.0, 120)


@every_camera
def test_camera_rejects_a_non_positive_exposure(factory):
    camera = factory(ManualClock())
    camera.connect()
    for invalid in (0.0, -1.0):
        with pytest.raises(ValueError):
            camera.expose(invalid, 100)


@every_camera
def test_frame_is_not_readable_before_the_exposure_finishes(factory):
    clock = ManualClock()
    camera = factory(clock)
    camera.connect()
    camera.expose(2000.0, 100)

    clock.advance(0.5)
    assert camera.exposure_complete() is False
    with pytest.raises(ValueError):
        camera.read_frame()


@every_camera
def test_frame_carries_complete_metadata(factory):
    """Criterion 3: exposure, gain, capturedAt and dimensions are all populated."""
    clock = ManualClock()
    camera = factory(clock)
    camera.connect()
    camera.expose(1500.0, 220)
    clock.advance(2.0)

    frame = camera.read_frame()
    assert frame.exposure_milliseconds == 1500.0
    assert frame.gain == 220
    assert frame.captured_at.tzinfo is not None
    assert frame.width_px > 0
    assert frame.height_px > 0
    assert frame.mode is camera.mode


# --------------------------------------------------------------------------
# Focusers
# --------------------------------------------------------------------------


@every_focuser
def test_focuser_satisfies_the_interface(factory):
    assert isinstance(factory(ManualClock()), FocuserDriver)


@every_focuser
def test_focuser_refuses_to_move_while_disconnected(factory):
    focuser = factory(ManualClock())
    with pytest.raises(NotConnectedError):
        focuser.move_to(1000)


@every_focuser
def test_focuser_rejects_a_position_outside_its_travel(factory):
    focuser = factory(ManualClock())
    focuser.connect()
    limit = focuser.status().max_position
    for invalid in (-1, limit + 1):
        with pytest.raises(ValueError):
            focuser.move_to(invalid)


@every_focuser
def test_focuser_reaches_the_commanded_position(factory):
    clock = ManualClock()
    focuser = factory(clock)
    focuser.connect()

    focuser.move_to(18000)
    clock.advance(600.0)

    status = focuser.status()
    assert status.moving is False
    assert status.position == 18000
