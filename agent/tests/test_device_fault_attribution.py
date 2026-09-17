"""Issue #112: a fault is recorded against the device that had it.

Every device error used to be reported as `MOUNT_FAULT`, including a camera that
could not read a frame and a focuser that would not move. The contract has a
reason for each, an operator reads that reason to know which instrument to go
and look at, and DV-037's failure drills record it as evidence.

The device is stamped on at the call, not at the raise, so a driver needs to know
nothing about this and a new one is covered the moment it is in `Devices`.
"""

from __future__ import annotations

import pytest

from contracts.models import MissionFailureReason, MissionState
from darkview_agent.clock import ManualClock
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.runtime import DeviceKind, Devices, fault_reason, faulted_device
from tests import command_fixtures as commands
from tests.agent_harness import build_agent, run_to
from tests.test_mission_runner import (
    NIGHT,
    build_runner,
    request,
    run_to_completion,
)


def devices(clock: ManualClock) -> Devices:
    mount = SimMount(clock=clock)
    return Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=64, height_px=64),
        focuser=SimFocuser(clock=clock),
    )


def refuse(*_args, **_kwargs):
    raise DeviceError("the device stopped answering")


# --------------------------------------------------------------------------
# The stamp
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("device", "kind"),
    [("mount", DeviceKind.MOUNT), ("camera", DeviceKind.CAMERA), ("focuser", DeviceKind.FOCUSER)],
)
def test_a_driver_error_carries_the_device_it_came_from(device, kind):
    all_devices = devices(ManualClock())
    getattr(all_devices, device).status = refuse

    with pytest.raises(DeviceError) as raised:
        getattr(all_devices, device).status()

    assert faulted_device(raised.value) is kind
    assert (
        fault_reason(raised.value)
        is {
            DeviceKind.MOUNT: MissionFailureReason.mount_fault,
            DeviceKind.CAMERA: MissionFailureReason.camera_fault,
            DeviceKind.FOCUSER: MissionFailureReason.focuser_fault,
        }[kind]
    )


def test_an_error_from_nowhere_in_particular_is_still_the_mount_s():
    """The mount is the device that moves; an unattributed fault assumes the worst."""
    assert fault_reason(DeviceError("something, somewhere")) is MissionFailureReason.mount_fault


def test_the_device_that_raised_keeps_the_fault_when_another_re_raises():
    all_devices = devices(ManualClock())
    error = DeviceError("the camera failed")
    error.darkview_device = DeviceKind.CAMERA
    all_devices.mount.status = lambda: (_ for _ in ()).throw(error)

    with pytest.raises(DeviceError) as raised:
        all_devices.mount.status()

    assert faulted_device(raised.value) is DeviceKind.CAMERA


def test_the_wrapper_is_otherwise_the_driver():
    all_devices = devices(ManualClock())
    assert isinstance(all_devices.mount.driver, SimMount)
    assert all_devices.mount.mode.value == "SIMULATED"

    all_devices.focuser.move_to = refuse
    assert all_devices.focuser.driver.move_to is not SimFocuser.move_to


# --------------------------------------------------------------------------
# The mission
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("device", "method", "reason"),
    [
        ("mount", "slew_to", MissionFailureReason.mount_fault),
        ("camera", "expose", MissionFailureReason.camera_fault),
    ],
)
def test_a_fault_mid_mission_names_the_device_that_failed(device, method, reason):
    clock = ManualClock()
    all_devices = devices(clock)
    setattr(getattr(all_devices, device), method, refuse)
    runner = build_runner(clock, devices=all_devices)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.hardware_error
    assert runner.failure_reason is reason


def test_a_focuser_that_will_not_move_is_a_focuser_fault():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)
    agent.devices.focuser.move_to = refuse

    agent.command(
        commands.envelope(
            command_type="FOCUS",
            payload={"kind": "FOCUS", "mode": "ABSOLUTE", "absolutePosition": 20000},
            issued_at=agent.wall.now,
        )
    )
    agent.advance(2.0)

    assert agent.supervisor.runner.failure_reason is MissionFailureReason.focuser_fault


def test_a_fault_during_a_command_carries_the_device_through_the_watchdog():
    """The command path reports through the watchdog, which now carries the device."""
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    agent.devices.mount.slew_to = refuse

    ack = agent.command(agent.nudge(step_arcminutes=6.0))

    assert ack["rejectionReason"] == "DEVICE_UNAVAILABLE"
    assert agent.supervisor.watchdog.actions[-1].device is DeviceKind.MOUNT
    failures = [event["failureReason"] for event in agent.events() if event["failureReason"]]
    assert failures[-1] == "MOUNT_FAULT"
