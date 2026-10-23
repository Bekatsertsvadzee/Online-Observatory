"""#199 -- the live view runs for the whole of OBSERVING, on the simulator.

Before this the camera sat idle while OBSERVING, the state the customer is there for:
they saw the last plate-solve frame for up to 30 seconds, then nothing until Capture.
"""

from __future__ import annotations

from contracts.models import ImagingProfile, MissionState
from darkview_agent.capture.profiles import Profile
from darkview_agent.clock import ManualClock
from darkview_agent.devices.simulated import SimCamera
from darkview_agent.mission.runner import MissionRunner
from darkview_agent.mission.solver import SimSolver
from darkview_agent.safety.envelope import SafetyEnvelope
from tests.envelope_fixtures import NIGHT, TBILISI, build_config
from tests.test_mission_runner import build_devices, request

TEN_MINUTES = 600.0
PUMP_SECONDS = 0.25


class OneExposureAtATime(SimCamera):
    """A camera that fails the test if asked to start an exposure over another."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.running = False
        self.exposures = 0

    def expose(self, exposure_milliseconds: float, gain: int) -> None:
        assert not self.running, "an exposure was started while one was running"
        super().expose(exposure_milliseconds, gain)
        self.running = True
        self.exposures += 1

    def read_frame(self):
        frame = super().read_frame()
        self.running = False
        return frame


def observing_runner(clock: ManualClock, shown: list, observing_seconds: float = TEN_MINUTES):
    devices = build_devices(clock)
    camera = OneExposureAtATime(clock=clock, mount=devices.mount, width_px=64, height_px=64)
    devices = type(devices)(mount=devices.mount, camera=camera, focuser=devices.focuser)
    runner = MissionRunner(
        devices=devices,
        envelope=SafetyEnvelope(config=build_config(max_altitude_degrees=68.0), site=TBILISI),
        solver=SimSolver(),
        clock=clock,
        show=lambda frame: shown.append((clock.monotonic(), frame)),
        observing_seconds=observing_seconds,
    )
    runner.offer(request(), NIGHT)
    for _ in range(400):
        runner.pump(NIGHT)
        if runner.state is MissionState.observing:
            return runner, camera
        clock.advance(1.0)
    raise AssertionError(f"never reached OBSERVING; stuck in {runner.state}")


def pump_for(runner: MissionRunner, clock: ManualClock, seconds: float) -> None:
    end = clock.monotonic() + seconds
    while clock.monotonic() < end and runner.state is MissionState.observing:
        runner.pump(NIGHT)
        clock.advance(PUMP_SECONDS)


def test_ten_minutes_of_observing_has_no_gap_longer_than_three_frames() -> None:
    clock = ManualClock()
    shown: list = []
    runner, _camera = observing_runner(clock, shown)
    entered = clock.monotonic()
    shown.clear()

    pump_for(runner, clock, TEN_MINUTES - 1)

    assert runner.state is MissionState.observing
    times = [entered] + [at for at, _frame in shown]
    interval = runner_exposure_seconds(runner)
    gaps = [later - earlier for earlier, later in zip(times, times[1:], strict=False)]
    assert len(shown) >= TEN_MINUTES / (interval + 1) * 0.9
    assert max(gaps) <= 3 * interval


def test_the_view_is_a_stack_that_climbs() -> None:
    clock = ManualClock()
    shown: list = []
    runner, _camera = observing_runner(clock, shown)
    shown.clear()

    pump_for(runner, clock, 20)

    counts = [frame.stacked_frames for _at, frame in shown]
    assert counts[:3] == [1, 2, 3]
    assert counts == sorted(counts)


def test_a_nudge_or_recentre_starts_a_new_stack() -> None:
    clock = ManualClock()
    shown: list = []
    runner, _camera = observing_runner(clock, shown)
    pump_for(runner, clock, 12)
    assert shown[-1][1].stacked_frames >= 3

    # Mid-exposure: the frame in flight shows the sky in between and is dropped.
    runner.pump(NIGHT)
    runner.pointing_changed()
    before = len(shown)
    pump_for(runner, clock, 12)

    after = [frame.stacked_frames for _at, frame in shown[before:]]
    assert after[0] == 1
    assert after == sorted(after)


def test_capture_waits_for_the_live_exposure_and_starts_its_own_stack() -> None:
    clock = ManualClock()
    shown: list = []
    runner, camera = observing_runner(clock, shown)
    pump_for(runner, clock, 7)
    assert camera.running, "expected a live exposure in flight"

    accepted = runner.request_capture(
        "cmd-1", ImagingProfile.double_star, Profile(exposure_milliseconds=250.0, gain=150, frames=4)
    )
    assert accepted
    for _ in range(200):
        runner.pump(NIGHT)
        clock.advance(PUMP_SECONDS)
        if runner.state is MissionState.complete:
            break

    assert runner.state is MissionState.complete
    assert runner.frames_captured == 4


def test_focus_waits_for_the_live_exposure() -> None:
    clock = ManualClock()
    shown: list = []
    runner, camera = observing_runner(clock, shown)
    pump_for(runner, clock, 7)
    assert camera.running

    assert runner.request_focus(None) is None
    # OneExposureAtATime fails the test if autofocus exposes over the live frame.
    pump_for(runner, clock, 60)
    assert runner.state is MissionState.observing


def runner_exposure_seconds(runner: MissionRunner) -> float:
    return runner._require_progress().request.exposure_milliseconds / 1000.0
