"""DV-026 — the mission state machine on the simulator.

Milestone S1: a mission runs the full state machine end to end with everything
real except the hardware.
"""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest

from contracts.models import MissionFailureReason, MissionState
from darkview_agent.clock import ManualClock
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.mission.runner import (
    MAX_CENTERING_ITERATIONS,
    MAX_SOLVE_ATTEMPTS,
    MissionAlreadyActive,
    MissionEvent,
    MissionRequest,
    MissionRunner,
)
from darkview_agent.mission.solver import SimSolver
from darkview_agent.runtime import Devices
from darkview_agent.safety.envelope import SafetyEnvelope
from tests.envelope_fixtures import NIGHT, TBILISI, build_config

# RA 18h Dec 0 sits at about 46 degrees from Tbilisi at NIGHT: inside the
# envelope, clear of the horizon mask, well away from the Sun.
TARGET_RA_HOURS = 18.0
TARGET_DEC_DEGREES = 0.0


def build_devices(clock: ManualClock) -> Devices:
    mount = SimMount(clock=clock)
    return Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=64, height_px=64),
        focuser=SimFocuser(clock=clock),
    )


def build_runner(
    clock: ManualClock,
    *,
    measured: bool = True,
    solver: SimSolver | None = None,
    site=TBILISI,
    events: list[MissionEvent] | None = None,
    devices: Devices | None = None,
    **config,
) -> MissionRunner:
    envelope = SafetyEnvelope(
        config=build_config(
            max_altitude_degrees=68.0 if measured else None,
            min_altitude_degrees=config.pop("min_altitude_degrees", 20.0),
            **config,
        ),
        site=site,
    )
    return MissionRunner(
        devices=devices or build_devices(clock),
        envelope=envelope,
        solver=solver or SimSolver(),
        clock=clock,
        emit=(events.append if events is not None else None),
    )


def request(**kwargs) -> MissionRequest:
    return MissionRequest(
        mission_id=kwargs.pop("mission_id", uuid4()),
        session_id=uuid4(),
        user_id=uuid4(),
        right_ascension_hours=kwargs.pop("ra_hours", TARGET_RA_HOURS),
        declination_degrees=kwargs.pop("dec_degrees", TARGET_DEC_DEGREES),
        **kwargs,
    )


def run_to_completion(
    runner: MissionRunner, clock: ManualClock, at_time=NIGHT, limit: int = 400
) -> int:
    """Pump until the mission stops moving. Returns the number of pumps used."""
    for step in range(limit):
        previous_state = runner.state
        runner.pump(at_time)
        if runner.state in (
            MissionState.complete,
            MissionState.failed,
            MissionState.cancelled,
            MissionState.hardware_error,
        ):
            return step
        # Advance time so slews and exposures can finish.
        clock.advance(1.0)
        if runner.state == previous_state:
            clock.advance(2.0)
    raise AssertionError(f"mission did not settle; stuck in {runner.state}")


# --------------------------------------------------------------------------
# Criterion 1 — a full mission traverses the contract states
# --------------------------------------------------------------------------


def test_a_full_simulated_mission_reaches_complete():
    """Milestone S1, in one test."""
    clock = ManualClock()
    events: list[MissionEvent] = []
    runner = build_runner(clock, events=events)

    runner.offer(request(requested_frames=3), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.complete
    assert runner.failure_reason is None


def test_the_mission_visits_the_states_in_contract_order():
    """Criterion 1: the states, and only the states, from the enumeration."""
    clock = ManualClock()
    events: list[MissionEvent] = []
    runner = build_runner(clock, events=events)

    runner.offer(request(requested_frames=2), NIGHT)
    run_to_completion(runner, clock)

    visited = [event.state for event in events]
    expected_order = [
        MissionState.preparing,
        MissionState.slewing,
        MissionState.verifying,
        MissionState.observing,
        MissionState.capturing,
        MissionState.processing,
        MissionState.complete,
    ]
    for state in expected_order:
        assert state in visited, f"never entered {state}"

    # Ordering: each expected state first appears after the previous one.
    first_seen = [visited.index(state) for state in expected_order]
    assert first_seen == sorted(first_seen), f"states out of order: {visited}"


def test_one_event_is_emitted_per_transition():
    """Criterion 1: one AgentMissionEvent per transition, no more."""
    clock = ManualClock()
    events: list[MissionEvent] = []
    runner = build_runner(clock, events=events)

    runner.offer(request(requested_frames=2), NIGHT)
    run_to_completion(runner, clock)

    assert len(events) == len(runner.history)
    # No state is emitted twice in a row: a transition is a change.
    consecutive = [
        (first.state, second.state)
        for first, second in zip(events, events[1:], strict=False)
    ]
    assert all(first is not second for first, second in consecutive)


def test_every_event_serialises_to_the_contract_shape():
    clock = ManualClock()
    events: list[MissionEvent] = []
    runner = build_runner(clock, events=events)

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    for event in events:
        message = event.to_message()
        assert message["type"] == "AGENT_MISSION_EVENT"
        assert message["state"] in {state.value for state in MissionState}
        assert message["occurredAt"] == NIGHT.isoformat()


def test_frames_are_actually_captured():
    clock = ManualClock()
    runner = build_runner(clock)

    runner.offer(request(requested_frames=4), NIGHT)
    run_to_completion(runner, clock)

    assert runner.frames_captured == 4


# --------------------------------------------------------------------------
# Criterion 2 — exactly one active mission
# --------------------------------------------------------------------------


def test_a_second_mission_is_refused_while_one_is_active():
    """Criterion 2."""
    clock = ManualClock()
    runner = build_runner(clock)

    first = request()
    runner.offer(first, NIGHT)
    assert runner.is_active is True

    with pytest.raises(MissionAlreadyActive) as raised:
        runner.offer(request(), NIGHT)

    assert str(first.mission_id) in str(raised.value)
    assert runner.mission_id == str(first.mission_id)


def test_the_refused_mission_never_reaches_the_hardware_layer():
    """Criterion 2: not queued, not started, no device touched on its behalf."""
    clock = ManualClock()
    devices = build_devices(clock)
    runner = build_runner(clock, devices=devices)

    runner.offer(request(), NIGHT)
    runner.pump(NIGHT)
    position_before = devices.mount.status()

    with pytest.raises(MissionAlreadyActive):
        runner.offer(request(ra_hours=6.0, dec_degrees=40.0), NIGHT)

    assert devices.mount.status().altitude_degrees == position_before.altitude_degrees


def test_the_lock_is_released_when_the_mission_finishes():
    clock = ManualClock()
    runner = build_runner(clock)

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    assert runner.is_active is False
    runner.offer(request(requested_frames=1), NIGHT)
    assert runner.is_active is True


def test_the_lock_is_released_after_a_failure_too():
    clock = ManualClock()
    runner = build_runner(clock, solver=SimSolver(fail_always=True))

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.failed
    assert runner.is_active is False
    runner.offer(request(), NIGHT)


# --------------------------------------------------------------------------
# Criterion 3 — slew timeout
# --------------------------------------------------------------------------


class StuckMount(SimMount):
    """A mount that starts a slew and never arrives."""

    def status(self):
        base = super().status()
        return type(base)(
            connected=base.connected,
            slewing=True,
            tracking=base.tracking,
            parked=base.parked,
            altitude_degrees=base.altitude_degrees,
            azimuth_degrees=base.azimuth_degrees,
            health=base.health,
            mode=base.mode,
        )


def test_a_slew_that_never_completes_times_out_and_parks():
    """Criterion 3."""
    clock = ManualClock()
    mount = StuckMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=64, height_px=64),
        focuser=SimFocuser(clock=clock),
    )
    runner = build_runner(clock, devices=devices)

    runner.offer(request(), NIGHT)
    runner.pump(NIGHT)
    assert runner.state is MissionState.slewing

    clock.advance(500.0)
    runner.pump(NIGHT)

    assert runner.state is MissionState.hardware_error
    assert runner.failure_reason is MissionFailureReason.slew_timeout
    assert runner.mount_parked is True


def test_a_slew_within_the_timeout_is_not_aborted():
    clock = ManualClock()
    runner = build_runner(clock)

    runner.offer(request(), NIGHT)
    runner.pump(NIGHT)
    clock.advance(5.0)
    runner.pump(NIGHT)

    assert runner.state is not MissionState.hardware_error


# --------------------------------------------------------------------------
# Criterion 4 — bounded plate solving and centering
# --------------------------------------------------------------------------


def test_three_consecutive_solve_failures_end_the_mission():
    """Criterion 4."""
    clock = ManualClock()
    solver = SimSolver(fail_always=True)
    runner = build_runner(clock, solver=solver)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.failed
    assert runner.failure_reason is MissionFailureReason.plate_solve_failed


def test_the_solver_is_never_asked_a_fourth_time_in_one_verify():
    """Criterion 4: the loop never runs a fourth iteration."""
    clock = ManualClock()
    solver = SimSolver(fail_always=True)
    runner = build_runner(clock, solver=solver)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert solver.solve_count == MAX_SOLVE_ATTEMPTS


def test_a_mission_recovers_from_solve_failures_below_the_limit():
    clock = ManualClock()
    runner = build_runner(clock, solver=SimSolver(fail_first=2, initial_error_degrees=0.0))

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.complete


def test_centering_is_bounded_to_three_iterations():
    """A mount that will not converge is stopped, not retried forever."""
    clock = ManualClock()
    # convergence_factor 1.0: the error never shrinks, so it never centres.
    solver = SimSolver(initial_error_degrees=1.0, convergence_factor=1.0)
    runner = build_runner(clock, solver=solver)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.failed
    assert runner.failure_reason is MissionFailureReason.centering_iterations_exhausted
    assert runner.centering_iterations == MAX_CENTERING_ITERATIONS


def test_a_mission_that_needs_centering_still_completes():
    clock = ManualClock()
    runner = build_runner(
        clock, solver=SimSolver(initial_error_degrees=0.5, convergence_factor=0.05)
    )

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.complete
    assert runner.centering_iterations >= 1


# --------------------------------------------------------------------------
# Criterion 5 — COMPLETE releases everything
# --------------------------------------------------------------------------


def test_complete_parks_the_mount_and_releases_the_lock():
    """Criterion 5."""
    clock = ManualClock()
    devices = build_devices(clock)
    runner = build_runner(clock, devices=devices)

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.complete
    assert runner.is_active is False
    assert runner.mount_parked is True
    assert devices.mount.status().parked is True
    assert devices.mount.status().tracking is False


# --------------------------------------------------------------------------
# Criterion 6 — every terminal path parks
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "make_runner"),
    [
        ("success", lambda clock: build_runner(clock)),
        (
            "plate solve failure",
            lambda clock: build_runner(clock, solver=SimSolver(fail_always=True)),
        ),
        (
            "centering exhausted",
            lambda clock: build_runner(
                clock, solver=SimSolver(initial_error_degrees=1.0, convergence_factor=1.0)
            ),
        ),
        ("unmeasured envelope", lambda clock: build_runner(clock, measured=False)),
        ("no site configured", lambda clock: build_runner(clock, site=None)),
    ],
)
def test_every_terminal_path_ends_parked(label, make_runner):
    """Criterion 6."""
    clock = ManualClock()
    runner = make_runner(clock)

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state in (
        MissionState.complete,
        MissionState.failed,
        MissionState.hardware_error,
    ), label
    assert runner.mount_parked is True, f"{label} did not park"
    assert runner.park_failure is None


def test_cancellation_parks():
    clock = ManualClock()
    runner = build_runner(clock)

    runner.offer(request(), NIGHT)
    runner.pump(NIGHT)
    runner.cancel(NIGHT, MissionFailureReason.customer_cancelled)

    assert runner.state is MissionState.cancelled
    assert runner.failure_reason is MissionFailureReason.customer_cancelled
    assert runner.mount_parked is True


def test_cancelling_when_nothing_is_running_is_harmless():
    clock = ManualClock()
    runner = build_runner(clock)
    runner.cancel(NIGHT, MissionFailureReason.operator_abort)
    assert runner.state is MissionState.scheduled


def test_a_park_that_fails_is_recorded_rather_than_swallowed():
    """Criterion 6: 'or with a logged reason it could not be'."""

    class UnparkableMount(SimMount):
        def park(self) -> None:
            raise DeviceError("park relay did not respond")

    clock = ManualClock()
    mount = UnparkableMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=64, height_px=64),
        focuser=SimFocuser(clock=clock),
    )
    runner = build_runner(clock, devices=devices)

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    assert runner.mount_parked is False
    assert runner.park_failure is not None
    assert "park relay" in runner.park_failure


# --------------------------------------------------------------------------
# Safety refuses the mission before any device is touched
# --------------------------------------------------------------------------


def test_an_unmeasured_envelope_refuses_the_mission():
    clock = ManualClock()
    runner = build_runner(clock, measured=False)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.failed
    assert runner.failure_reason is MissionFailureReason.safety_envelope_unmeasured


def test_a_target_outside_the_envelope_refuses_the_mission():
    clock = ManualClock()
    runner = build_runner(clock)

    # Declination -60 never rises above the 20-degree minimum from Tbilisi.
    runner.offer(request(ra_hours=6.0, dec_degrees=-60.0), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.failed
    assert runner.failure_reason is MissionFailureReason.safety_refused


def test_the_mount_is_not_moved_when_safety_refuses():
    clock = ManualClock()
    devices = build_devices(clock)
    runner = build_runner(clock, devices=devices, measured=False)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert devices.mount.status().parked is True


# --------------------------------------------------------------------------
# Criterion 7 — only contract state names
# --------------------------------------------------------------------------


def test_every_emitted_state_belongs_to_the_contract_enumeration():
    """Criterion 7."""
    clock = ManualClock()
    events: list[MissionEvent] = []
    runner = build_runner(clock, events=events)

    runner.offer(request(requested_frames=2), NIGHT)
    run_to_completion(runner, clock)

    for event in events:
        assert isinstance(event.state, MissionState)


def test_no_locked_or_delivered_state_exists():
    """ADR-004: LOCKED and DELIVERED are display labels, never states."""
    names = {state.value for state in MissionState}
    assert "LOCKED" not in names
    assert "DELIVERED" not in names


def test_failure_reasons_are_never_used_as_states():
    clock = ManualClock()
    events: list[MissionEvent] = []
    runner = build_runner(clock, solver=SimSolver(fail_always=True), events=events)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    state_values = {event.state.value for event in events}
    reason_values = {reason.value for reason in MissionFailureReason}
    assert state_values.isdisjoint(reason_values)


# --------------------------------------------------------------------------
# Idle parking after COMPLETE
# --------------------------------------------------------------------------


def test_the_mount_stays_parked_through_the_idle_window():
    clock = ManualClock()
    runner = build_runner(clock)

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)
    assert runner.mount_parked is True

    clock.advance(600.0)
    runner.pump(NIGHT + timedelta(minutes=10))

    assert runner.mount_parked is True


def test_a_failed_park_is_retried_after_the_idle_window():
    """A park that did not work is worth attempting again.

    An unparked mount is exactly the condition the idle window exists to
    resolve, so the window retries rather than simply noting the failure.
    """

    class FlakyMount(SimMount):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.park_attempts = 0

        def park(self) -> None:
            self.park_attempts += 1
            if self.park_attempts == 1:
                raise DeviceError("park relay did not respond")
            super().park()

    clock = ManualClock()
    mount = FlakyMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=64, height_px=64),
        focuser=SimFocuser(clock=clock),
    )
    runner = build_runner(clock, devices=devices)

    runner.offer(request(requested_frames=1), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.complete
    assert runner.mount_parked is False, "first park should have failed"

    clock.advance(600.0)
    runner.pump(NIGHT)

    assert runner.mount_parked is True
    assert runner.park_failure is None
    assert mount.park_attempts == 2


def test_a_device_fault_mid_mission_becomes_a_hardware_error():
    """A device that fails while the mission is running ends it and parks."""

    class FaultingCamera(SimCamera):
        def expose(self, exposure_milliseconds: float, gain: int) -> None:
            raise DeviceError("sensor readout failed")

    clock = ManualClock()
    mount = SimMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=FaultingCamera(clock=clock, mount=mount, width_px=64, height_px=64),
        focuser=SimFocuser(clock=clock),
    )
    runner = build_runner(clock, devices=devices)

    runner.offer(request(), NIGHT)
    run_to_completion(runner, clock)

    assert runner.state is MissionState.hardware_error
    assert runner.failure_reason is MissionFailureReason.mount_fault
    assert runner.mount_parked is True


def test_pumping_before_any_mission_is_offered_does_nothing():
    clock = ManualClock()
    runner = build_runner(clock)
    runner.pump(NIGHT)
    assert runner.state is MissionState.scheduled


def test_a_solver_with_no_commanded_position_reports_no_solution():
    """Defensive: asked to solve before the mount was told where to go."""
    from datetime import UTC as _UTC
    from datetime import datetime as _datetime

    import numpy as np

    from contracts.models import ObservatoryMode
    from darkview_agent.devices.frame import Frame

    solver = SimSolver()
    frame = Frame(
        pixels=np.zeros((4, 4), dtype=np.uint16),
        exposure_milliseconds=100.0,
        gain=0,
        captured_at=_datetime.now(_UTC),
        mode=ObservatoryMode.simulated,
    )
    assert solver.solve(frame) is None
