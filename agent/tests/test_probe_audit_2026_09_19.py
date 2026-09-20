"""Audit probes, 2026-09-19, now regression tests. Each encodes the behaviour the
ADRs or CLAUDE.md claim and each failed when it was written. Simulator only.

Where a probe built an envelope the contract now refuses outright, it builds a
valid one and overwrites the field with `model_copy`: the schema bound is the
first line of defence and these are about the second -- what the agent does with
a number that reached it anyway.
"""

from __future__ import annotations

import math
import uuid
from datetime import timedelta

import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.command.validator import CommandValidator
from darkview_agent.config import load_config
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.mission.runner import MissionRequest, MissionRunner
from darkview_agent.mission.solver import SimSolver
from darkview_agent.runtime import Devices
from darkview_agent.safety import sun
from darkview_agent.safety.envelope import SafetyEnvelope
from tests import command_fixtures as commands
from tests.agent_harness import NIGHT as HARNESS_NIGHT
from tests.agent_harness import build_agent
from tests.command_fixtures import OWNERSHIP, envelope, goto_payload, nudge_payload
from tests.envelope_fixtures import NIGHT, NOON, TBILISI, build_config


def _validate(cfg, raw, at, pointing=None):
    validator = CommandValidator(
        envelope=SafetyEnvelope(config=cfg, site=TBILISI), attended=False, pointing=pointing
    )
    validator.set_ownership(OWNERSHIP)
    return validator.validate(raw, at)


def _sun_goto():
    position = sun.equatorial_position(NOON)
    return envelope(
        command_type="GOTO",
        payload=goto_payload(
            ra_hours=position.right_ascension_hours, dec_degrees=position.declination_degrees
        ),
        issued_at=NOON,
    )


# P0. ADR-013: "The Sun exclusion remains unreachable from any parameter on any
# path." envelope.py:170 compares against config.sun_exclusion_degrees, which the
# cloud sets (contract minimum 0).
@pytest.mark.parametrize("daylight_lock", [90.0, float("nan")])
@pytest.mark.parametrize("exclusion", [0.0, 0.5])
def test_probe_cloud_envelope_cannot_open_the_sun(exclusion, daylight_lock):
    cfg = build_config(max_altitude_degrees=85.0).model_copy(
        update={
            "sun_exclusion_degrees": exclusion,
            "daylight_lock_sun_altitude_degrees": daylight_lock,
        }
    )
    ack = _validate(cfg, _sun_goto(), NOON)
    assert ack.status.value == "REJECTED", "an unattended GOTO onto the Sun was ACCEPTED"


# P1. A NaN daylight lock makes `solar_alt > nan` False, so the lock never engages.
def test_probe_nan_daylight_lock_does_not_disable_the_lock():
    position = sun.equatorial_position(NOON)
    away_from_sun = envelope(
        command_type="GOTO",
        payload=goto_payload(
            ra_hours=(position.right_ascension_hours + 3.5) % 24,
            dec_degrees=position.declination_degrees,
        ),
        issued_at=NOON,
    )
    cfg = build_config(max_altitude_degrees=85.0).model_copy(
        update={"daylight_lock_sun_altitude_degrees": float("nan")}
    )
    ack = _validate(cfg, away_from_sun, NOON)
    assert ack.status.value == "REJECTED"


# P1. CLAUDE.md: device fault -> stop capture, halt motion, Park. On the runner
# path (runner.py:373-381) a mid-slew fault only parks.
def test_probe_mount_fault_mid_slew_aborts_slew_and_capture_before_park():
    calls: list[str] = []

    class FaultyMount(SimMount):
        fault = False

        def status(self):
            if FaultyMount.fault:
                raise DeviceError("mount fault mid-slew")
            return super().status()

        def abort_slew(self):
            calls.append("abort_slew")
            super().abort_slew()

        def park(self):
            calls.append("park")
            super().park()

    class RecordingCamera(SimCamera):
        def abort_exposure(self):
            calls.append("abort_exposure")
            super().abort_exposure()

    clock = ManualClock()
    mount = FaultyMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=RecordingCamera(clock=clock, mount=mount, width_px=64, height_px=64),
        focuser=SimFocuser(clock=clock),
    )
    runner = MissionRunner(
        devices, SafetyEnvelope(build_config(max_altitude_degrees=85.0), TBILISI), SimSolver(),
        clock=clock,
    )
    runner.offer(MissionRequest(uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), 18.6, 38.8), NIGHT)
    runner.pump(NIGHT)
    FaultyMount.fault = True
    runner.pump(NIGHT)

    assert "abort_slew" in calls and "abort_exposure" in calls, calls
    assert calls.index("abort_slew") < calls.index("park"), calls


# P2. A non-finite mount reading must produce a refusal, not an exception that
# leaves the cloud without an ack (angular_separation -> math domain error).
@pytest.mark.parametrize("altitude", [math.inf, -math.inf])
def test_probe_non_finite_pointing_refuses_instead_of_raising(altitude):
    cfg = build_config(max_altitude_degrees=85.0)
    at = NOON + timedelta(hours=13)
    raw = envelope(command_type="NUDGE", payload=nudge_payload(), issued_at=at)
    ack = _validate(cfg, raw, at, pointing=lambda: (altitude, 100.0))
    assert ack.status.value == "REJECTED"


# P2. "Neither replayed nor lost": the commandId is persisted before execution
# (validator.py:249-251, supervisor.py:583-585). A crash in that window turns the
# cloud's retry into DUPLICATE and the GOTO never happens.
def test_probe_command_is_not_lost_when_the_agent_dies_after_validation(tmp_path):
    path = tmp_path / "agent-state.sqlite3"
    agent = build_agent(max_altitude_degrees=70.0, state_path=path)
    agent.own()
    goto = agent.goto()
    agent.supervisor.validator.validate(goto, agent.wall.now)
    agent.close()

    revived = build_agent(max_altitude_degrees=70.0, state_path=path)
    try:
        revived.own()
        ack = revived.command(goto)
        assert not (
            ack["status"] == "DUPLICATE" and not revived.supervisor.runner.is_active
        ), "the command was recorded as seen but never executed"
    finally:
        revived.close()


# P2. CloudWelcome.serverTime exists "for agent clock-skew detection"
# (openapi.yaml) and the agent never reads it. With the agent 10 minutes ahead,
# every fresh cloud command is refused as expired.
def test_probe_agent_clock_ahead_of_cloud_does_not_expire_fresh_commands():
    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.wall.now = HARNESS_NIGHT + timedelta(minutes=10)
        agent.own()
        ack = agent.command(commands.envelope(command_type="PARK", issued_at=HARNESS_NIGHT))
        assert ack["status"] != "EXPIRED", ack
    finally:
        agent.close()


# P3. AgentConfig is a frozen dataclass with the default repr, which includes the
# device token. One `logger.debug("%r", config)` would leak it.
def test_probe_agent_config_repr_does_not_carry_the_device_token():
    token = "probe-secret-token-value"
    config = load_config({"DARKVIEW_AGENT_DEVICE_TOKEN": token})
    assert token not in repr(config)
    assert token not in str(config)
