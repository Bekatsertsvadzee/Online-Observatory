"""Where the mount is pointing, sent to the cloud as AGENT_STATE_DELTA (#148).

The customer's room shows a dial with a marker for the telescope. These tests
drive a whole agent against SimMount and read what reached the fake socket: the
marker travels during a slew, the cadence is bounded, nothing is queued, and
sampling never writes to a device.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from contracts.models import AgentStateDelta, MissionState
from darkview_agent.clock import ManualClock
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.runtime import Devices
from darkview_agent.safety.coordinates import equatorial_to_horizontal
from darkview_agent.telemetry import (
    REFRESH_INTERVAL_SECONDS,
    SAMPLE_INTERVAL_SECONDS,
    TelemetryReporter,
)
from tests import command_fixtures as commands
from tests.agent_harness import (
    NIGHT,
    TARGET_DEC_DEGREES,
    TARGET_RA_HOURS,
    build_agent,
    run_to,
)
from tests.envelope_fixtures import TBILISI


def _deltas(agent) -> list[dict]:
    return agent.sent("AGENT_STATE_DELTA")


def _slewing_agent():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.slewing)
    return agent


def test_the_marker_travels_during_a_simulated_slew_and_settles_on_the_target():
    agent = _slewing_agent()
    before = len(_deltas(agent))

    # Pumped at the loop's own pace, 0.25 s, until the mount has arrived.
    for _ in range(400):
        agent.advance(0.25)
        if not agent.mount.status().slewing:
            break
    agent.advance(REFRESH_INTERVAL_SECONDS, steps=20)

    during = [
        delta for delta in _deltas(agent)[before:] if delta["telemetry"]["slewing"]
    ]
    assert len(during) >= 10, "a slew of this length should be sampled many times"
    for delta in during:
        AgentStateDelta.model_validate(delta)
        assert delta["missionId"] == str(commands.MISSION_ID)
        assert delta["missionState"] == "SLEWING"
        assert delta["telemetry"]["mode"] == "SIMULATED"

    altitudes = [delta["telemetry"]["pointingHorizontal"]["altitudeDegrees"] for delta in during]
    assert altitudes == sorted(altitudes), "the marker moves one way, towards the target"
    assert len(set(altitudes)) == len(altitudes), "every sample is a new position"

    # Where it settled is where the target is (no solve error in this agent).
    target = equatorial_to_horizontal(
        TARGET_RA_HOURS, TARGET_DEC_DEGREES, NIGHT, TBILISI
    )
    settled = _deltas(agent)[-1]["telemetry"]
    assert settled["slewing"] is False
    assert abs(settled["pointingHorizontal"]["altitudeDegrees"] - target.altitude_degrees) < 1.0


def test_samples_are_at_most_two_a_second_while_the_mount_moves():
    agent = _slewing_agent()
    before = len(_deltas(agent))

    for _ in range(30):  # three seconds of a fast loop, still mid-slew
        agent.advance(0.1)
    assert agent.mount.status().slewing is True

    sent = _deltas(agent)[before:]
    assert 5 <= len(sent) <= 7
    stamps = [datetime.fromisoformat(delta["sentAt"]) for delta in sent]
    pairs = zip(stamps, stamps[1:], strict=False)
    gaps = [(later - earlier).total_seconds() for earlier, later in pairs]
    assert min(gaps) >= SAMPLE_INTERVAL_SECONDS - 1e-9


def test_a_standing_mount_is_restated_only_on_change_or_every_few_seconds():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.advance(0.5)
    before = len(_deltas(agent))
    assert before >= 1, "a fresh connection is told where the mount is at once"

    agent.advance(REFRESH_INTERVAL_SECONDS - 1.0, steps=16)
    assert len(_deltas(agent)) == before, "nothing changed, nothing is due"

    agent.advance(1.0, steps=4)
    assert len(_deltas(agent)) == before + 1, "the refresh a new subscriber relies on"

    idle = _deltas(agent)[-1]
    assert idle["missionId"] is None
    assert idle["telemetry"]["parked"] is True
    assert idle["telemetry"]["pointingHorizontal"] == {
        "altitudeDegrees": 0.0,
        "azimuthDegrees": 0.0,
    }


def test_nothing_is_sampled_or_queued_while_the_link_is_down():
    agent = _slewing_agent()
    agent.connector.current.kill()
    agent.pump()
    assert not agent.supervisor.link.is_online
    queued = agent.supervisor.link.queued_count

    for _ in range(8):
        agent.clock.advance(0.5)
        agent.wall.advance(0.5)
        agent.supervisor.pump()

    assert agent.supervisor.link.queued_count == queued, "a sample is never queued"

    # The agent has re-dialled by now; the new socket carries nothing until welcomed.
    assert _deltas(agent) == []
    agent.connector.current.deliver_welcome(server_time=agent.wall.now)
    agent.pump()
    assert agent.supervisor.link.is_online
    assert len(_deltas(agent)) == 1, "the new connection is told at once"


def test_every_sample_names_weather_honestly():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.advance(0.5)
    assert _deltas(agent)[-1]["telemetry"]["weather"]["status"] == "UNKNOWN"

    agent.weather(hold_active=True, status="CLOUDY")
    agent.advance(0.5)
    weather = _deltas(agent)[-1]["telemetry"]["weather"]
    assert weather["status"] == "CLOUDY"
    assert weather["holdActive"] is True


def test_samples_are_sent_outside_the_device_lock():
    agent = _slewing_agent()
    lock = agent.supervisor.watchdog.device_lock
    held: list[bool] = []
    original = agent.supervisor.link.send_state_delta

    def record(delta):
        held.append(lock._is_owned())
        return original(delta)

    agent.supervisor.link.send_state_delta = record  # type: ignore[method-assign]
    agent.advance(2.0, steps=8)

    assert held, "nothing was sent, so nothing was checked"
    assert not any(held)


class _RecordingMount(SimMount):
    """A SimMount that records every call that could move it."""

    def __init__(self, clock) -> None:
        super().__init__(clock)
        self.writes: list[str] = []

    def slew_to(self, altitude_degrees, azimuth_degrees):
        self.writes.append("slew_to")
        return super().slew_to(altitude_degrees, azimuth_degrees)

    def abort_slew(self):
        self.writes.append("abort_slew")
        return super().abort_slew()

    def park(self):
        self.writes.append("park")
        return super().park()

    def unpark(self):
        self.writes.append("unpark")
        return super().unpark()

    def set_tracking(self, tracking):
        self.writes.append("set_tracking")
        return super().set_tracking(tracking)


def test_sampling_reads_the_mount_and_never_moves_it():
    clock = ManualClock()
    mount = _RecordingMount(clock)
    mount.connect()
    mount.unpark()
    mount.slew_to(45.0, 90.0)
    mount.writes.clear()
    reporter = TelemetryReporter(
        Devices(mount=mount, camera=SimCamera(clock, mount), focuser=SimFocuser(clock)),
        agent_version="test",
        started_at=NIGHT,
    )

    at = NIGHT
    for _ in range(20):
        clock.advance(0.5)
        at += timedelta(seconds=0.5)
        reporter.sample(
            at, mission_id=None, mission_state=None, centering_iteration=None, weather=None
        )

    assert mount.writes == []


def test_an_unreadable_mount_is_reported_as_a_fault_with_no_position():
    clock = ManualClock()
    mount = SimMount(clock)

    def broken():
        raise DeviceError("the driver stopped answering")

    mount.status = broken  # type: ignore[method-assign]
    reporter = TelemetryReporter(
        Devices(mount=mount, camera=SimCamera(clock, mount), focuser=SimFocuser(clock)),
        agent_version="test",
        started_at=NIGHT,
    )

    delta = reporter.sample(
        NIGHT, mission_id=None, mission_state=None, centering_iteration=None, weather=None
    )

    assert delta is not None
    AgentStateDelta.model_validate(delta)
    assert delta["telemetry"]["mount"]["health"] == "FAULT"
    assert delta["telemetry"]["pointingHorizontal"] is None
