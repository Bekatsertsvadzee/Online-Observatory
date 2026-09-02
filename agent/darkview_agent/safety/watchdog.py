"""The watchdog.

Heartbeat loss, weather, device fault and operator abort all converge on one
terminal sequence: stop capture, abort slew, Park.

It runs on its own thread. That is the entire point. Everything else in the
agent is a polled state machine driven by a main loop, which is fine until the
main loop is the thing that has gone wrong — blocked on a socket, wedged in a
driver call, stuck behind a slow disk. A watchdog that lived in that loop would
be asleep in exactly the situation it exists for.

It never depends on the cloud being reachable. If the link has been dead for
`linkDeadSeconds` it parks with no cloud involvement, and it parks just the same
when the cloud has never been reachable since start-up — an observatory that
booted into a network outage still has a telescope pointing somewhere.

Two thresholds, both from SafetyEnvelopeConfig:

    heartbeatLossSeconds   capture stops; the mount keeps tracking
    linkDeadSeconds        the mount parks

The gap between them is deliberate. A brief network stall should not cost a
customer their session; a sustained one must not leave a telescope tracking
unattended.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum

from contracts.models import SafetyEnvelopeConfig
from darkview_agent.clock import Clock, SystemClock
from darkview_agent.command.audit import AuditEvent, AuditLog
from darkview_agent.runtime import Devices

logger = logging.getLogger("darkview.agent.watchdog")

# Used only when no envelope has arrived yet. Deliberately short: an agent that
# does not yet know its own thresholds should be more cautious, not less.
FALLBACK_HEARTBEAT_LOSS_SECONDS = 15.0
FALLBACK_LINK_DEAD_SECONDS = 60.0

DEFAULT_POLL_INTERVAL_SECONDS = 0.5


class WatchdogTrigger(StrEnum):
    heartbeat_lost = "HEARTBEAT_LOST"
    link_dead = "LINK_DEAD"
    device_fault = "DEVICE_FAULT"
    operator_abort = "OPERATOR_ABORT"
    weather_unsafe = "WEATHER_UNSAFE"


@dataclass(frozen=True)
class WatchdogAction:
    """What the watchdog did on one evaluation."""

    trigger: WatchdogTrigger
    stopped_capture: bool = False
    parked: bool = False
    park_failure: str | None = None
    detail: str = ""


class Watchdog:
    """Decides and acts. Safe to call from the watchdog thread or the main loop.

    All device access is taken under a lock. The drivers are not thread-safe and
    the main control loop touches the same ones, so a Park racing a slew command
    would be a genuine hazard rather than a theoretical one. The lock is
    injectable precisely so the main loop can share it.
    """

    def __init__(
        self,
        devices: Devices,
        clock: Clock | None = None,
        audit: AuditLog | None = None,
        config: SafetyEnvelopeConfig | None = None,
        device_lock: threading.RLock | None = None,
    ) -> None:
        self._devices = devices
        self._clock = clock or SystemClock()
        # Not `audit or AuditLog()`: AuditLog defines __len__, so an empty one is
        # falsy and an injected log would be silently discarded.
        self._audit = AuditLog() if audit is None else audit
        self._config = config
        self._lock = device_lock or threading.RLock()

        # Never seen online. The timers run from start-up, so criterion 4 holds:
        # an agent that booted into an outage still parks.
        self._booted_monotonic = self._clock.monotonic()
        self._last_online_monotonic: float | None = None

        self._capture_stopped = False
        self._parked = False
        self._park_failure: str | None = None
        self._actions: list[WatchdogAction] = []
        self._pending_trigger: WatchdogTrigger | None = None
        self._pending_detail = ""

    # ------------------------------------------------------------------
    # What the rest of the agent tells it
    # ------------------------------------------------------------------

    @property
    def audit(self) -> AuditLog:
        return self._audit

    @property
    def device_lock(self) -> threading.RLock:
        """Share this with the main control loop so device access is serialised."""
        return self._lock

    @property
    def capture_stopped(self) -> bool:
        return self._capture_stopped

    @property
    def parked(self) -> bool:
        return self._parked

    @property
    def park_failure(self) -> str | None:
        return self._park_failure

    @property
    def actions(self) -> list[WatchdogAction]:
        return list(self._actions)

    def set_config(self, config: SafetyEnvelopeConfig) -> None:
        self._config = config

    def link_is_online(self) -> None:
        """Called whenever the link confirms it is alive.

        Resets both timers and clears the stopped-capture latch, so a recovered
        link lets a mission resume rather than staying suppressed.
        """
        with self._lock:
            self._last_online_monotonic = self._clock.monotonic()
            self._capture_stopped = False

    def report_device_fault(self, detail: str) -> None:
        """Criterion 3: a fault from any driver triggers the terminal sequence."""
        self._raise(WatchdogTrigger.device_fault, detail)

    def operator_abort(self, detail: str = "operator abort") -> None:
        self._raise(WatchdogTrigger.operator_abort, detail)

    def weather_unsafe(self, detail: str = "weather unsafe") -> None:
        self._raise(WatchdogTrigger.weather_unsafe, detail)

    def _raise(self, trigger: WatchdogTrigger, detail: str) -> None:
        with self._lock:
            self._pending_trigger = trigger
            self._pending_detail = detail

    # ------------------------------------------------------------------
    # Thresholds
    # ------------------------------------------------------------------

    @property
    def heartbeat_loss_seconds(self) -> float:
        if self._config is None:
            return FALLBACK_HEARTBEAT_LOSS_SECONDS
        return float(self._config.heartbeat_loss_seconds)

    @property
    def link_dead_seconds(self) -> float:
        if self._config is None:
            return FALLBACK_LINK_DEAD_SECONDS
        return float(self._config.link_dead_seconds)

    def seconds_since_online(self) -> float:
        """How long since the link was last confirmed alive.

        Measured from start-up when it has never been alive at all.
        """
        reference = (
            self._last_online_monotonic
            if self._last_online_monotonic is not None
            else self._booted_monotonic
        )
        return self._clock.monotonic() - reference

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def evaluate(self) -> WatchdogAction | None:
        """Decide and act. Returns what it did, or None if nothing was due."""
        with self._lock:
            if self._pending_trigger is not None:
                trigger, detail = self._pending_trigger, self._pending_detail
                self._pending_trigger = None
                self._pending_detail = ""
                return self._act(trigger, detail, stop_capture=True, park=True)

            elapsed = self.seconds_since_online()

            if elapsed >= self.link_dead_seconds and not self._parked:
                return self._act(
                    WatchdogTrigger.link_dead,
                    f"link dead for {elapsed:.1f}s (limit {self.link_dead_seconds:.0f}s)",
                    stop_capture=True,
                    park=True,
                )

            if elapsed >= self.heartbeat_loss_seconds and not self._capture_stopped:
                return self._act(
                    WatchdogTrigger.heartbeat_lost,
                    f"no heartbeat for {elapsed:.1f}s "
                    f"(limit {self.heartbeat_loss_seconds:.0f}s)",
                    stop_capture=True,
                    park=False,
                )

            return None

    def _act(
        self, trigger: WatchdogTrigger, detail: str, *, stop_capture: bool, park: bool
    ) -> WatchdogAction:
        """Criterion 5: the event is written before anything is touched.

        If the process dies mid-action the record still says what it was about to
        do and why, which is the difference between a diagnosable incident and a
        telescope found in an unexplained position.
        """
        self._audit.record(
            AuditEvent(
                occurred_at=datetime.now(UTC),
                kind="WATCHDOG_TRIGGERED",
                reason=trigger.value,
                detail=detail,
                context={"stopCapture": stop_capture, "park": park},
            )
        )
        logger.warning("watchdog: %s (%s)", trigger.value, detail)

        stopped = False
        if stop_capture:
            stopped = self._stop_capture()

        parked = False
        park_failure: str | None = None
        if park:
            parked, park_failure = self._park()

        action = WatchdogAction(
            trigger=trigger,
            stopped_capture=stopped,
            parked=parked,
            park_failure=park_failure,
            detail=detail,
        )
        self._actions.append(action)
        return action

    def _stop_capture(self) -> bool:
        try:
            self._devices.camera.abort_exposure()
            self._capture_stopped = True
            return True
        except Exception as error:
            logger.error("watchdog could not stop capture: %s", error)
            return False

    def _park(self) -> tuple[bool, str | None]:
        """Abort motion, then park. Both are attempted even if the first fails.

        A mount that will not abort might still park, and a parked mount is the
        outcome that matters.
        """
        try:
            self._devices.mount.abort_slew()
        except Exception as error:
            logger.error("watchdog could not abort the slew: %s", error)

        try:
            self._devices.mount.park()
            self._parked = True
            self._park_failure = None
            return True, None
        except Exception as error:
            self._parked = False
            self._park_failure = str(error)
            logger.error("watchdog could not park the mount: %s", error)
            return False, str(error)


class WatchdogThread:
    """Runs a watchdog on its own thread.

    Deliberately trivial. Everything that decides anything lives in `Watchdog`,
    where it can be tested against an injected clock; this only makes sure the
    decisions keep being made when the main loop has stopped making progress.
    """

    def __init__(
        self, watchdog: Watchdog, interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS
    ) -> None:
        self._watchdog = watchdog
        self._interval = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.is_running:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="darkview-watchdog", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._watchdog.evaluate()
            except Exception:
                # A watchdog that dies on an unexpected error is worse than no
                # watchdog, because it looks like one. Keep going.
                logger.exception("watchdog evaluation raised; continuing")
            self._stop.wait(self._interval)

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None
