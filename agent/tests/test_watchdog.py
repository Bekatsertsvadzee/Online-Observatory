"""DV-024 — the watchdog.

Timing is tested against an injected clock. The thread is tested for real,
because "it keeps working when the main loop is blocked" is not a claim a fake
clock can support.
"""

from __future__ import annotations

import threading
import time

import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.command.audit import AuditLog
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.runtime import Devices
from darkview_agent.safety.watchdog import (
    FALLBACK_HEARTBEAT_LOSS_SECONDS,
    FALLBACK_LINK_DEAD_SECONDS,
    Watchdog,
    WatchdogThread,
    WatchdogTrigger,
)
from tests.envelope_fixtures import build_config

HEARTBEAT_LOSS_SECONDS = 15
LINK_DEAD_SECONDS = 60


def build_devices(clock) -> Devices:
    mount = SimMount(clock=clock)
    return Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=32, height_px=32),
        focuser=SimFocuser(clock=clock),
    )


def build_watchdog(clock: ManualClock, devices: Devices | None = None) -> Watchdog:
    return Watchdog(
        devices=devices or build_devices(clock),
        clock=clock,
        audit=AuditLog(),
        config=build_config(
            max_altitude_degrees=68.0,
            heartbeat_loss_seconds=HEARTBEAT_LOSS_SECONDS,
            link_dead_seconds=LINK_DEAD_SECONDS,
        ),
    )


# --------------------------------------------------------------------------
# Criterion 1 — the two thresholds
# --------------------------------------------------------------------------


def test_capture_stops_at_the_heartbeat_loss_threshold():
    """Criterion 1, first half."""
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    watchdog.link_is_online()

    clock.advance(HEARTBEAT_LOSS_SECONDS - 0.1)
    assert watchdog.evaluate() is None, "acted before the threshold"

    clock.advance(0.2)
    action = watchdog.evaluate()

    assert action is not None
    assert action.trigger is WatchdogTrigger.heartbeat_lost
    assert action.stopped_capture is True
    assert watchdog.capture_stopped is True


def test_the_mount_keeps_tracking_at_the_heartbeat_threshold():
    """The gap between the thresholds is the point: a brief stall must not cost
    a customer their session."""
    clock = ManualClock()
    devices = build_devices(clock)
    watchdog = build_watchdog(clock, devices)
    watchdog.link_is_online()

    clock.advance(HEARTBEAT_LOSS_SECONDS + 1.0)
    action = watchdog.evaluate()

    assert action.parked is False
    assert watchdog.parked is False


def test_the_mount_parks_at_the_link_dead_threshold():
    """Criterion 1, second half."""
    clock = ManualClock()
    devices = build_devices(clock)
    devices.mount.connect()
    devices.mount.unpark()
    watchdog = build_watchdog(clock, devices)
    watchdog.link_is_online()

    clock.advance(HEARTBEAT_LOSS_SECONDS + 1.0)
    watchdog.evaluate()
    assert watchdog.parked is False

    clock.advance(LINK_DEAD_SECONDS)
    action = watchdog.evaluate()

    assert action.trigger is WatchdogTrigger.link_dead
    assert action.parked is True
    assert devices.mount.status().parked is True


def test_no_park_before_the_link_dead_threshold():
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    watchdog.link_is_online()

    clock.advance(LINK_DEAD_SECONDS - 0.1)
    watchdog.evaluate()

    assert watchdog.parked is False


def test_an_active_exposure_is_aborted_when_capture_stops():
    clock = ManualClock()
    devices = build_devices(clock)
    devices.camera.connect()
    devices.camera.expose(30000.0, 100)
    watchdog = build_watchdog(clock, devices)
    watchdog.link_is_online()

    clock.advance(HEARTBEAT_LOSS_SECONDS + 1.0)
    watchdog.evaluate()

    assert devices.camera.status().exposing is False


def test_a_recovered_link_lets_capture_resume():
    """A stopped capture is a latch, not a death sentence."""
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    watchdog.link_is_online()

    clock.advance(HEARTBEAT_LOSS_SECONDS + 1.0)
    watchdog.evaluate()
    assert watchdog.capture_stopped is True

    watchdog.link_is_online()
    assert watchdog.capture_stopped is False

    clock.advance(1.0)
    assert watchdog.evaluate() is None


def test_the_thresholds_come_from_the_envelope():
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    assert watchdog.heartbeat_loss_seconds == HEARTBEAT_LOSS_SECONDS
    assert watchdog.link_dead_seconds == LINK_DEAD_SECONDS


def test_a_watchdog_without_an_envelope_uses_cautious_fallbacks():
    """An agent that does not yet know its thresholds should be more careful,
    not less."""
    clock = ManualClock()
    watchdog = Watchdog(devices=build_devices(clock), clock=clock)

    assert watchdog.heartbeat_loss_seconds == FALLBACK_HEARTBEAT_LOSS_SECONDS
    assert watchdog.link_dead_seconds == FALLBACK_LINK_DEAD_SECONDS


def test_an_envelope_arriving_later_replaces_the_fallbacks():
    clock = ManualClock()
    watchdog = Watchdog(devices=build_devices(clock), clock=clock)
    watchdog.set_config(
        build_config(
            max_altitude_degrees=68.0,
            heartbeat_loss_seconds=8,
            link_dead_seconds=30,
        )
    )
    assert watchdog.heartbeat_loss_seconds == 8
    assert watchdog.link_dead_seconds == 30


# --------------------------------------------------------------------------
# Criterion 4 — it parks even if the cloud was never reachable
# --------------------------------------------------------------------------


def test_the_mount_parks_when_the_cloud_has_never_been_reachable():
    """Criterion 4. An observatory that booted into a network outage still has a
    telescope pointing somewhere."""
    clock = ManualClock()
    devices = build_devices(clock)
    devices.mount.connect()
    devices.mount.unpark()
    watchdog = build_watchdog(clock, devices)
    # link_is_online() is deliberately never called.

    clock.advance(LINK_DEAD_SECONDS + 1.0)
    action = watchdog.evaluate()

    assert action.trigger is WatchdogTrigger.link_dead
    assert action.parked is True
    assert devices.mount.status().parked is True


def test_the_timers_run_from_start_up_when_never_online():
    clock = ManualClock()
    watchdog = build_watchdog(clock)

    clock.advance(10.0)
    assert watchdog.seconds_since_online() == pytest.approx(10.0)


# --------------------------------------------------------------------------
# Criterion 3 — a device fault triggers the same sequence
# --------------------------------------------------------------------------


def test_a_device_fault_stops_capture_and_parks():
    """Criterion 3."""
    clock = ManualClock()
    devices = build_devices(clock)
    devices.mount.connect()
    devices.mount.unpark()
    watchdog = build_watchdog(clock, devices)
    watchdog.link_is_online()

    watchdog.report_device_fault("camera readout failed")
    action = watchdog.evaluate()

    assert action.trigger is WatchdogTrigger.device_fault
    assert action.stopped_capture is True
    assert action.parked is True
    assert devices.mount.status().parked is True


def test_a_device_fault_acts_immediately_without_waiting_for_a_threshold():
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    watchdog.link_is_online()

    watchdog.report_device_fault("mount lost tracking")
    action = watchdog.evaluate()

    assert action is not None
    assert watchdog.seconds_since_online() < HEARTBEAT_LOSS_SECONDS


def test_an_operator_abort_triggers_the_same_sequence():
    clock = ManualClock()
    devices = build_devices(clock)
    devices.mount.connect()
    devices.mount.unpark()
    watchdog = build_watchdog(clock, devices)
    watchdog.link_is_online()

    watchdog.operator_abort("operator pressed stop")
    action = watchdog.evaluate()

    assert action.trigger is WatchdogTrigger.operator_abort
    assert action.parked is True


def test_a_weather_trigger_triggers_the_same_sequence():
    clock = ManualClock()
    devices = build_devices(clock)
    devices.mount.connect()
    devices.mount.unpark()
    watchdog = build_watchdog(clock, devices)
    watchdog.link_is_online()

    watchdog.weather_unsafe("rain detected")
    action = watchdog.evaluate()

    assert action.trigger is WatchdogTrigger.weather_unsafe
    assert action.parked is True


def test_an_explicit_trigger_outranks_a_threshold():
    """The specific cause is more useful in a log than a timer that also fired."""
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    watchdog.link_is_online()
    clock.advance(LINK_DEAD_SECONDS + 1.0)

    watchdog.report_device_fault("focuser jammed")
    action = watchdog.evaluate()

    assert action.trigger is WatchdogTrigger.device_fault


# --------------------------------------------------------------------------
# Criterion 5 — the event is written before it acts
# --------------------------------------------------------------------------


def test_every_action_writes_an_event_with_its_trigger():
    """Criterion 5."""
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    watchdog.link_is_online()

    clock.advance(HEARTBEAT_LOSS_SECONDS + 1.0)
    watchdog.evaluate()

    events = watchdog.audit.events_of_kind("WATCHDOG_TRIGGERED")
    assert len(events) == 1
    assert events[0].reason == WatchdogTrigger.heartbeat_lost.value
    assert events[0].detail


def test_the_event_is_written_before_the_device_is_touched():
    """Criterion 5, the ordering that matters.

    If the process dies mid-action the record still says what it was about to do
    and why, which is the difference between a diagnosable incident and a
    telescope found in an unexplained position.
    """
    order: list[str] = []
    clock = ManualClock()

    class RecordingMount(SimMount):
        def abort_slew(self) -> None:
            order.append("abort_slew")
            super().abort_slew()

        def park(self) -> None:
            order.append("park")
            super().park()

    class RecordingCamera(SimCamera):
        def abort_exposure(self) -> None:
            order.append("abort_exposure")
            super().abort_exposure()

    class RecordingAudit(AuditLog):
        def record(self, event):
            order.append("audit")
            return super().record(event)

    mount = RecordingMount(clock=clock)
    watchdog = Watchdog(
        devices=Devices(
            mount=mount,
            camera=RecordingCamera(clock=clock, mount=mount, width_px=32, height_px=32),
            focuser=SimFocuser(clock=clock),
        ),
        clock=clock,
        audit=RecordingAudit(),
        config=build_config(
            max_altitude_degrees=68.0,
            heartbeat_loss_seconds=HEARTBEAT_LOSS_SECONDS,
            link_dead_seconds=LINK_DEAD_SECONDS,
        ),
    )

    watchdog.report_device_fault("fault")
    watchdog.evaluate()

    assert order[0] == "audit", f"a device was touched before the record: {order}"
    assert order == ["audit", "abort_exposure", "abort_slew", "park"], order


def test_a_park_that_fails_is_recorded_rather_than_raised():
    class UnparkableMount(SimMount):
        def park(self) -> None:
            raise DeviceError("park relay did not respond")

    clock = ManualClock()
    mount = UnparkableMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=32, height_px=32),
        focuser=SimFocuser(clock=clock),
    )
    watchdog = build_watchdog(clock, devices)

    watchdog.report_device_fault("something")
    action = watchdog.evaluate()

    assert action.parked is False
    assert action.park_failure is not None
    assert watchdog.park_failure is not None


def test_park_is_attempted_even_when_aborting_the_slew_fails():
    """A mount that will not abort might still park, and parked is what matters."""

    class StubbornMount(SimMount):
        def abort_slew(self) -> None:
            raise DeviceError("abort ignored")

    clock = ManualClock()
    mount = StubbornMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=SimCamera(clock=clock, mount=mount, width_px=32, height_px=32),
        focuser=SimFocuser(clock=clock),
    )
    watchdog = build_watchdog(clock, devices)

    watchdog.report_device_fault("something")
    action = watchdog.evaluate()

    assert action.parked is True


def test_a_camera_that_will_not_stop_does_not_prevent_the_park():
    class StuckCamera(SimCamera):
        def abort_exposure(self) -> None:
            raise DeviceError("camera not responding")

    clock = ManualClock()
    mount = SimMount(clock=clock)
    devices = Devices(
        mount=mount,
        camera=StuckCamera(clock=clock, mount=mount, width_px=32, height_px=32),
        focuser=SimFocuser(clock=clock),
    )
    watchdog = build_watchdog(clock, devices)

    watchdog.report_device_fault("something")
    action = watchdog.evaluate()

    assert action.stopped_capture is False
    assert action.parked is True


# --------------------------------------------------------------------------
# Criterion 2 — its own thread, working while the main loop is blocked
# --------------------------------------------------------------------------


def test_the_watchdog_runs_on_its_own_thread():
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    runner = WatchdogThread(watchdog, interval_seconds=0.01)

    assert runner.is_running is False
    runner.start()
    try:
        assert runner.is_running is True
    finally:
        runner.stop()
    assert runner.is_running is False


def test_the_watchdog_acts_while_the_main_control_loop_is_blocked():
    """Criterion 2, the reason the thread exists.

    The main loop is held inside a device call — the exact failure a polled
    watchdog would sleep through. This uses real time, because a fake clock
    cannot demonstrate that a blocked thread did not prevent progress.
    """
    clock = ManualClock()
    devices = build_devices(clock)
    devices.mount.connect()
    devices.mount.unpark()
    watchdog = build_watchdog(clock, devices)

    runner = WatchdogThread(watchdog, interval_seconds=0.01)
    runner.start()
    try:
        # The main loop wedges. Nothing in it will pump anything.
        main_loop_blocked = threading.Event()

        def blocked_main_loop() -> None:
            main_loop_blocked.set()
            time.sleep(0.5)

        worker = threading.Thread(target=blocked_main_loop)
        worker.start()
        assert main_loop_blocked.wait(timeout=1.0)

        # Time passes past the link-dead threshold while the main loop is stuck.
        clock.advance(LINK_DEAD_SECONDS + 1.0)

        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not watchdog.parked:
            time.sleep(0.01)

        assert watchdog.parked is True, "the watchdog did not act while the loop was blocked"
        assert worker.is_alive(), "the main loop should still be blocked"
        worker.join()
    finally:
        runner.stop()


def test_the_thread_survives_an_evaluation_that_raises():
    """A watchdog that dies on an unexpected error is worse than none, because
    it looks like one."""

    class ExplodingWatchdog(Watchdog):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.calls = 0

        def evaluate(self):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("unexpected")
            return None

    clock = ManualClock()
    watchdog = ExplodingWatchdog(devices=build_devices(clock), clock=clock)
    runner = WatchdogThread(watchdog, interval_seconds=0.01)

    runner.start()
    try:
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and watchdog.calls < 3:
            time.sleep(0.01)
        assert watchdog.calls >= 3, "the thread stopped after the first exception"
    finally:
        runner.stop()


def test_starting_twice_does_not_create_a_second_thread():
    clock = ManualClock()
    runner = WatchdogThread(build_watchdog(clock), interval_seconds=0.01)
    runner.start()
    try:
        first = runner._thread
        runner.start()
        assert runner._thread is first
    finally:
        runner.stop()


def test_stopping_a_watchdog_that_never_started_is_harmless():
    clock = ManualClock()
    WatchdogThread(build_watchdog(clock)).stop()


def test_device_access_is_serialised_by_a_lock():
    """The drivers are not thread-safe and the main loop touches the same ones.
    A Park racing a slew command is a real hazard, not a theoretical one."""
    clock = ManualClock()
    watchdog = build_watchdog(clock)

    assert watchdog.device_lock is not None
    with watchdog.device_lock:
        # Re-entrant: the watchdog takes it again inside evaluate().
        watchdog.report_device_fault("fault")
        assert watchdog.evaluate() is not None


def test_a_shared_lock_can_be_injected_for_the_main_loop():
    clock = ManualClock()
    shared = threading.RLock()
    watchdog = Watchdog(devices=build_devices(clock), clock=clock, device_lock=shared)
    assert watchdog.device_lock is shared


def test_the_action_history_is_readable_and_is_a_copy():
    """An operator reviewing an incident needs the sequence, not just the latest."""
    clock = ManualClock()
    watchdog = build_watchdog(clock)
    watchdog.link_is_online()

    clock.advance(HEARTBEAT_LOSS_SECONDS + 1.0)
    watchdog.evaluate()
    clock.advance(LINK_DEAD_SECONDS)
    watchdog.evaluate()

    actions = watchdog.actions
    assert [action.trigger for action in actions] == [
        WatchdogTrigger.heartbeat_lost,
        WatchdogTrigger.link_dead,
    ]

    actions.clear()
    assert len(watchdog.actions) == 2, "the history must not be mutable from outside"


def test_an_injected_audit_log_is_actually_used():
    """Regression: an empty AuditLog is falsy because it defines __len__, so
    `audit or AuditLog()` silently discarded the caller's log.
    """
    clock = ManualClock()
    shared = AuditLog()
    watchdog = Watchdog(devices=build_devices(clock), clock=clock, audit=shared)

    watchdog.report_device_fault("fault")
    watchdog.evaluate()

    assert watchdog.audit is shared
    assert len(shared.events_of_kind("WATCHDOG_TRIGGERED")) == 1
