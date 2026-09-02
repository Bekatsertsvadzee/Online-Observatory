"""The mission state machine, running against the simulator.

PREPARING -> SLEWING -> VERIFYING -> CENTERING -> OBSERVING -> CAPTURING ->
PROCESSING -> COMPLETE, with every failure and hold path ending at Park.

Three rules shape the whole file.

**One mission at a time, enforced locally.** The cloud also enforces it. That is
not a reason to trust it: a second mission arriving while one is running is
refused here, by a lock this process holds, and never reaches the hardware layer.

**Every terminal path parks.** Success, failure, hold, cancellation — the mount
ends parked, or the reason it could not be is recorded. A telescope left tracking
after a mission ends is a telescope pointing somewhere nobody is watching.

**Polled, with injected time.** Like the link and the devices: `pump()` does
whatever the clock says is due. A slew timeout is tested by advancing a fake
clock, not by waiting.

State names come from `contracts/openapi.yaml` and nowhere else.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from contracts.models import MissionFailureReason, MissionState
from darkview_agent.clock import Clock, SystemClock
from darkview_agent.devices.base import DeviceError
from darkview_agent.mission.solver import PlateSolver
from darkview_agent.runtime import Devices
from darkview_agent.safety.coordinates import equatorial_to_horizontal
from darkview_agent.safety.envelope import SafetyEnvelope

logger = logging.getLogger("darkview.agent.mission")

# The centering loop is bounded. Three attempts is the Build Plan's figure and
# it is a hard ceiling, not a target: a mount that has not converged in three
# corrections has something wrong with it that more attempts will not fix.
MAX_CENTERING_ITERATIONS = 3
MAX_SOLVE_ATTEMPTS = 3

# How close is close enough to stop centering.
CENTERING_TOLERANCE_DEGREES = 0.05

DEFAULT_EXPOSURE_MILLISECONDS = 2000.0
DEFAULT_GAIN = 200
DEFAULT_CAPTURE_FRAMES = 10

# After COMPLETE, how long the mount waits for a following mission before parking.
DEFAULT_IDLE_PARK_SECONDS = 120.0

TERMINAL_STATES = {
    MissionState.complete,
    MissionState.failed,
    MissionState.cancelled,
    MissionState.hardware_error,
    MissionState.weather_hold,
    MissionState.not_visible,
}


@dataclass(frozen=True)
class MissionRequest:
    """What the cloud asks the observatory to do."""

    mission_id: uuid.UUID
    session_id: uuid.UUID
    user_id: uuid.UUID
    right_ascension_hours: float
    declination_degrees: float
    requested_frames: int = DEFAULT_CAPTURE_FRAMES
    exposure_milliseconds: float = DEFAULT_EXPOSURE_MILLISECONDS
    gain: int = DEFAULT_GAIN


@dataclass(frozen=True)
class MissionEvent:
    """One state transition, as the agent saw it."""

    mission_id: str
    state: MissionState
    occurred_at: datetime
    failure_reason: MissionFailureReason | None = None
    detail: str = ""

    def to_message(self) -> dict:
        """The AgentMissionEvent the link sends."""
        return {
            "type": "AGENT_MISSION_EVENT",
            "messageId": str(uuid.uuid4()),
            "sentAt": datetime.now(UTC).isoformat(),
            "missionId": self.mission_id,
            "state": self.state.value,
            "failureReason": (
                self.failure_reason.value if self.failure_reason else None
            ),
            "occurredAt": self.occurred_at.isoformat(),
            "detail": self.detail or None,
        }


class MissionAlreadyActive(Exception):
    """A mission was offered while one is already running."""


@dataclass
class _Progress:
    """Everything the runner is keeping track of for the current mission."""

    request: MissionRequest
    started_at: datetime
    state_entered_monotonic: float
    centering_iterations: int = 0
    solve_attempts: int = 0
    frames_captured: int = 0
    exposure_started: bool = False
    parked: bool = False
    park_failure: str | None = None
    completed_monotonic: float | None = None
    events: list[MissionEvent] = field(default_factory=list)


class MissionRunner:
    """Runs one mission at a time against whatever devices it was given."""

    def __init__(
        self,
        devices: Devices,
        envelope: SafetyEnvelope,
        solver: PlateSolver,
        clock: Clock | None = None,
        emit: Callable[[MissionEvent], None] | None = None,
        idle_park_seconds: float = DEFAULT_IDLE_PARK_SECONDS,
    ) -> None:
        self._devices = devices
        self._envelope = envelope
        self._solver = solver
        self._clock = clock or SystemClock()
        self._emit = emit or (lambda event: None)
        self._idle_park_seconds = idle_park_seconds

        self._state = MissionState.scheduled
        self._failure_reason: MissionFailureReason | None = None
        self._progress: _Progress | None = None
        self._history: list[MissionEvent] = []

    # ------------------------------------------------------------------
    # Observable state
    # ------------------------------------------------------------------

    @property
    def state(self) -> MissionState:
        return self._state

    @property
    def failure_reason(self) -> MissionFailureReason | None:
        return self._failure_reason

    @property
    def is_active(self) -> bool:
        """True while a mission holds the lock."""
        return self._progress is not None and self._state not in TERMINAL_STATES

    @property
    def mission_id(self) -> str | None:
        return str(self._progress.request.mission_id) if self._progress else None

    @property
    def history(self) -> list[MissionEvent]:
        return list(self._history)

    @property
    def mount_parked(self) -> bool:
        return self._progress.parked if self._progress else True

    @property
    def frames_captured(self) -> int:
        return self._progress.frames_captured if self._progress else 0

    @property
    def centering_iterations(self) -> int:
        return self._progress.centering_iterations if self._progress else 0

    # ------------------------------------------------------------------
    # Accepting work
    # ------------------------------------------------------------------

    def offer(self, request: MissionRequest, at_time: datetime) -> None:
        """Take on a mission, or refuse because one is already running.

        Criterion 2: the refusal happens here, before anything reaches the
        hardware layer. Nothing is queued.
        """
        if self.is_active:
            logger.warning(
                "refusing mission %s: mission %s is already active",
                request.mission_id,
                self.mission_id,
            )
            raise MissionAlreadyActive(
                f"mission {self.mission_id} is already active; "
                f"{request.mission_id} was not queued"
            )

        self._progress = _Progress(
            request=request,
            started_at=at_time,
            state_entered_monotonic=self._clock.monotonic(),
        )
        self._failure_reason = None
        self._transition(MissionState.preparing, at_time)

    def cancel(self, at_time: datetime, reason: MissionFailureReason) -> None:
        """End the mission early. Parks, like every other terminal path."""
        if not self.is_active:
            return
        self._fail(MissionState.cancelled, reason, at_time, "cancelled")

    # ------------------------------------------------------------------
    # The pump
    # ------------------------------------------------------------------

    def pump(self, at_time: datetime) -> None:
        """Advance the mission by whatever the clock permits."""
        if self._progress is None:
            return

        if self._state is MissionState.complete:
            self._park_when_idle(at_time)
            return
        if self._state in TERMINAL_STATES:
            return

        handler = {
            MissionState.preparing: self._do_preparing,
            MissionState.slewing: self._do_slewing,
            MissionState.verifying: self._do_verifying,
            MissionState.centering: self._do_centering,
            MissionState.observing: self._do_observing,
            MissionState.capturing: self._do_capturing,
            MissionState.processing: self._do_processing,
        }.get(self._state)

        if handler is None:
            return

        try:
            handler(at_time)
        except DeviceError as error:
            self._fail(
                MissionState.hardware_error,
                MissionFailureReason.mount_fault,
                at_time,
                str(error),
            )

    # ------------------------------------------------------------------
    # States
    # ------------------------------------------------------------------

    def _do_preparing(self, at_time: datetime) -> None:
        progress = self._require_progress()
        request = progress.request

        # The safety envelope decides before any device is touched.
        if self._envelope.site is None:
            self._fail(
                MissionState.failed,
                MissionFailureReason.safety_refused,
                at_time,
                "observatory coordinates are not configured",
            )
            return

        horizontal = equatorial_to_horizontal(
            request.right_ascension_hours,
            request.declination_degrees,
            at_time,
            self._envelope.site,
        )
        verdict = self._envelope.evaluate_pointing(
            at_time, horizontal.altitude_degrees, horizontal.azimuth_degrees
        )
        if not verdict.permitted:
            reason = (
                MissionFailureReason.safety_envelope_unmeasured
                if not self._envelope.is_measured
                else MissionFailureReason.safety_refused
            )
            self._fail(MissionState.failed, reason, at_time, verdict.detail)
            return

        self._devices.mount.connect()
        self._devices.camera.connect()
        self._devices.focuser.connect()
        self._devices.mount.unpark()
        self._devices.mount.set_tracking(True)

        self._begin_slew(horizontal.altitude_degrees, horizontal.azimuth_degrees, at_time)

    def _begin_slew(self, altitude: float, azimuth: float, at_time: datetime) -> None:
        progress = self._require_progress()
        self._devices.mount.slew_to(altitude, azimuth)
        if hasattr(self._solver, "set_commanded_position"):
            self._solver.set_commanded_position(
                progress.request.right_ascension_hours,
                progress.request.declination_degrees,
            )
        self._transition(MissionState.slewing, at_time)

    def _do_slewing(self, at_time: datetime) -> None:
        progress = self._require_progress()
        elapsed = self._clock.monotonic() - progress.state_entered_monotonic
        timeout = self._slew_timeout_seconds()

        if self._devices.mount.status().slewing:
            if elapsed > timeout:
                # Criterion 3: abort the slew, then fail and park.
                self._devices.mount.abort_slew()
                self._fail(
                    MissionState.hardware_error,
                    MissionFailureReason.slew_timeout,
                    at_time,
                    f"slew exceeded {timeout:.0f}s",
                )
            return

        self._transition(MissionState.verifying, at_time)

    def _do_verifying(self, at_time: datetime) -> None:
        progress = self._require_progress()

        if not progress.exposure_started:
            self._devices.camera.expose(
                progress.request.exposure_milliseconds, progress.request.gain
            )
            progress.exposure_started = True
            return

        if not self._devices.camera.exposure_complete():
            return

        frame = self._devices.camera.read_frame()
        progress.exposure_started = False
        progress.solve_attempts += 1

        solved = self._solver.solve(frame)
        if solved is None:
            # Criterion 4: bounded attempts, and never a fourth.
            if progress.solve_attempts >= MAX_SOLVE_ATTEMPTS:
                self._fail(
                    MissionState.failed,
                    MissionFailureReason.plate_solve_failed,
                    at_time,
                    f"{progress.solve_attempts} consecutive plate solves failed",
                )
            return

        offset = abs(solved.declination_degrees - progress.request.declination_degrees)
        if offset <= CENTERING_TOLERANCE_DEGREES:
            self._transition(MissionState.observing, at_time)
            return

        self._transition(MissionState.centering, at_time)

    def _do_centering(self, at_time: datetime) -> None:
        progress = self._require_progress()

        if progress.centering_iterations >= MAX_CENTERING_ITERATIONS:
            self._fail(
                MissionState.failed,
                MissionFailureReason.centering_iterations_exhausted,
                at_time,
                f"target not centred after {MAX_CENTERING_ITERATIONS} corrections",
            )
            return

        progress.centering_iterations += 1
        progress.solve_attempts = 0

        horizontal = equatorial_to_horizontal(
            progress.request.right_ascension_hours,
            progress.request.declination_degrees,
            at_time,
            self._envelope.site,
        )
        self._begin_slew(horizontal.altitude_degrees, horizontal.azimuth_degrees, at_time)

    def _do_observing(self, at_time: datetime) -> None:
        self._transition(MissionState.capturing, at_time)

    def _do_capturing(self, at_time: datetime) -> None:
        progress = self._require_progress()

        if not progress.exposure_started:
            self._devices.camera.expose(
                progress.request.exposure_milliseconds, progress.request.gain
            )
            progress.exposure_started = True
            return

        if not self._devices.camera.exposure_complete():
            return

        self._devices.camera.read_frame()
        progress.exposure_started = False
        progress.frames_captured += 1

        if progress.frames_captured >= progress.request.requested_frames:
            self._transition(MissionState.processing, at_time)

    def _do_processing(self, at_time: datetime) -> None:
        # Live stacking and upload are DV-033. The state exists now so the
        # machine is complete and the transition is observable.
        self._transition(MissionState.complete, at_time)
        self._park("mission complete")
        progress = self._require_progress()
        progress.completed_monotonic = self._clock.monotonic()

    def _park_when_idle(self, at_time: datetime) -> None:
        """Criterion 5: park if no mission follows within the configured window.

        The mount is parked the moment the mission completes — waiting would
        leave it tracking a target nobody is watching. This is the retry for the
        case that matters: the park at COMPLETE failed. A park that did not work
        is worth attempting again, and an unparked mount is exactly the condition
        the idle window exists to resolve.
        """
        progress = self._require_progress()
        if progress.completed_monotonic is None or progress.parked:
            return
        if self._clock.monotonic() - progress.completed_monotonic >= self._idle_park_seconds:
            logger.warning("mount is still unparked after the idle window; retrying")
            self._park("retry after the idle window")

    # ------------------------------------------------------------------
    # Terminal handling
    # ------------------------------------------------------------------

    def _fail(
        self,
        state: MissionState,
        reason: MissionFailureReason,
        at_time: datetime,
        detail: str,
    ) -> None:
        self._failure_reason = reason
        self._transition(state, at_time, reason=reason, detail=detail)
        self._park(f"{state.value}: {reason.value}")

    def _park(self, why: str) -> None:
        """Criterion 6: every terminal path parks, or records why it could not.

        Park is attempted even when the mount is faulted, because a mount that
        might respond should be asked. A failure here is recorded rather than
        raised: there is nothing further the runner could do about it, and losing
        the mission's outcome to a secondary error would be worse.
        """
        progress = self._progress
        if progress is None:
            return
        try:
            self._devices.mount.park()
            progress.parked = True
            progress.park_failure = None
            logger.info("mount parked (%s)", why)
        except Exception as error:
            progress.parked = False
            progress.park_failure = str(error)
            logger.error("could not park the mount (%s): %s", why, error)

    @property
    def park_failure(self) -> str | None:
        return self._progress.park_failure if self._progress else None

    # ------------------------------------------------------------------
    # Plumbing
    # ------------------------------------------------------------------

    def _transition(
        self,
        state: MissionState,
        at_time: datetime,
        reason: MissionFailureReason | None = None,
        detail: str = "",
    ) -> None:
        progress = self._require_progress()
        self._state = state
        progress.state_entered_monotonic = self._clock.monotonic()

        event = MissionEvent(
            mission_id=str(progress.request.mission_id),
            state=state,
            occurred_at=at_time,
            failure_reason=reason,
            detail=detail,
        )
        progress.events.append(event)
        self._history.append(event)
        self._emit(event)
        logger.info("mission %s -> %s", progress.request.mission_id, state.value)

    def _slew_timeout_seconds(self) -> float:
        config = self._envelope.config
        return float(config.slew_timeout_seconds) if config else 120.0

    def _require_progress(self) -> _Progress:
        assert self._progress is not None
        return self._progress
