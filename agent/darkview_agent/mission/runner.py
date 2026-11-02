"""The mission state machine, running against the simulator.

PREPARING -> SLEWING -> VERIFYING -> CENTERING -> OBSERVING -> CAPTURING ->
PROCESSING -> COMPLETE, with every failure and hold path ending at Park.

A booked session observes for its whole slot (ADR-079): PROCESSING returns to
OBSERVING while the slot runs, so the customer may capture again; a RETARGET goes
OBSERVING -> SLEWING and acquires the new object the way the first was acquired;
and the slot's end goes OBSERVING -> COMPLETE (or flushes a capture through
PROCESSING) and parks. While OBSERVING the agent watches its own picture and
recovers it (ADR-080, `mission/watch.py`).

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
import math
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta

from contracts.models import (
    ImageHealthReason,
    ImagingProfile,
    MissionFailureReason,
    MissionState,
    OpticalConfig,
)
from darkview_agent.capture import profiles
from darkview_agent.capture.profiles import Profile
from darkview_agent.capture.scene import (
    SCENE_FOR_PROFILE,
    AutoExposure,
    Disc,
    disc_centroid,
    drifted,
    is_disc,
    stats,
)
from darkview_agent.capture.stack import LiveStack, integration_seconds
from darkview_agent.clock import Clock, SystemClock, wire_timestamp
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.frame import Frame
from darkview_agent.focus.autofocus import Autofocus, FocusMove, FocusResult
from darkview_agent.mission.solver import PlateSolver, SolveResult, separation_degrees
from darkview_agent.mission.watch import (
    CLOUD_BACKGROUND_RATIO,
    Baseline,
    ImageWatch,
    Need,
    judge,
)
from darkview_agent.runtime import Devices, fault_reason, field_height_degrees
from darkview_agent.safety.coordinates import equatorial_to_horizontal
from darkview_agent.safety.envelope import SafetyEnvelope

logger = logging.getLogger("darkview.agent.mission")

# The centering loop is bounded. Three attempts is the Phase 1 figure and
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

#: The longest a mission observes when nobody has told the agent when its session
#: ends. The observing deadline is the session's `expiresAt` (ADR-079 §2), which
#: the cloud always sends; this is only the ceiling for an agent that was never
#: told, so a telescope never tracks past the longest slot that can be booked
#: (clients ADR-072: four hours).
MAX_OBSERVING_SECONDS = 4 * 3600.0

#: A RETARGET needs this much of the session left (ADR-079 §4).
RETARGET_CLOSE_SECONDS = 300.0

#: How long the mount stays on an object before the customer may switch (ADR-079 §4),
#: and the clock skew the agent forgives the cloud on it.
DWELL_SECONDS = 600.0
DWELL_SKEW_TOLERANCE_SECONDS = 15.0

#: Frames smaller than this on their short side carry too little sky for the
#: statistics to mean anything (the star finder alone ignores 24 pixels of edge),
#: so they are shown and stacked but neither judged nor auto-exposed.
MIN_JUDGED_FRAME_PX = 128

#: OFF_CENTRE for deep sky: the larger of two arcminutes and a tenth of the field's
#: short side (ADR-080 §2). For a disc: a tenth of the short side, and VERIFYING
#: settles at half that so a freshly centred disc is not called off-centre at once.
OFF_CENTRE_MIN_DEGREES = 2.0 / 60.0
OFF_CENTRE_FIELD_FRACTION = 0.10
DISC_CENTRED_FIELD_FRACTION = 0.05

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
    operator_override: bool = False
    """Whether this mission may run with the Sun up.

    Only ever true for an attended operator at the observatory, decided locally.
    Without it a daylight command accepted by the validator would be refused here
    a moment later, and attended terrestrial testing -- which DV-034 and DV-035
    depend on -- could not happen at all. It never lifts the Sun exclusion; the
    envelope refuses that regardless of who asked.
    """
    target_id: uuid.UUID | None = None
    #: Sets the auto-exposure scene, and for LUNAR and PLANETARY the disc centroid
    #: in place of a plate solve (ADR-080). None: a deep-sky field, no auto exposure.
    imaging_profile: ImagingProfile | None = None
    optical_config: OpticalConfig = OpticalConfig.f10_native


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
            "sentAt": wire_timestamp(),
            "missionId": self.mission_id,
            "state": self.state.value,
            "failureReason": (
                self.failure_reason.value if self.failure_reason else None
            ),
            "occurredAt": wire_timestamp(self.occurred_at),
            "detail": self.detail or None,
        }


@dataclass(frozen=True)
class FinishedCapture:
    """A capture run that produced an image, waiting to be uploaded.

    The runner does not upload it. Object storage is reached over HTTP with a
    grant the cloud has to be asked for, and the runner holds the watchdog's
    device lock -- so it produces this, hands it over, and goes back to parking
    the mount. What happens to it next is `Supervisor`'s problem.
    """

    mission_id: str
    command_id: str
    imaging_profile: ImagingProfile
    frame: Frame
    frames_stacked: int
    exposure_milliseconds: float
    gain: int
    captured_at: datetime
    #: The object the mount was on when the run was made (ADR-079 §3).
    target_id: uuid.UUID | None = None

    @property
    def integration_seconds(self) -> float:
        return integration_seconds(self.exposure_milliseconds, self.frames_stacked)


class MissionAlreadyActive(Exception):
    """A mission was offered while one is already running."""


@dataclass
class _Progress:
    """Everything the runner is keeping track of for the current mission."""

    request: MissionRequest
    #: Where the mount was last sent, in RA hours and Dec degrees. The request's
    #: position until a centring correction moves it.
    aim: tuple[float, float]
    started_at: datetime
    state_entered_monotonic: float
    centering_iterations: int = 0
    solve_attempts: int = 0
    #: The solve CENTERING corrects from.
    solved: SolveResult | None = None
    #: A FOCUS in progress. OBSERVING holds while it runs.
    focus: Autofocus | FocusMove | None = None
    frames_captured: int = 0
    exposure_started: bool = False
    #: What the exposure running while OBSERVING is for: the live view (#199), an
    #: auto-exposure try, or a solve. Kept apart from `exposure_started`, which
    #: belongs to the acquisition and the capture run.
    job: str | None = None
    job_settings: tuple[float, int] | None = None
    #: The live view's exposure and gain. The request's until auto exposure moves them.
    live_exposure_milliseconds: float = DEFAULT_EXPOSURE_MILLISECONDS
    live_gain: int = DEFAULT_GAIN
    #: What the CAPTURE asked for; the live settings are left alone.
    capture_settings: Profile | None = None
    #: The mission reached OBSERVING once. From then on an image problem never
    #: fails it (ADR-080 §3) and the slot's end completes it (ADR-079 §2).
    acquired: bool = False
    observing_since_monotonic: float | None = None
    session_end: datetime | None = None
    #: When the agent accepted the GOTO or RETARGET that put the mount here.
    dwell_started_at: datetime | None = None
    watch: ImageWatch | None = None
    auto_exposure: AutoExposure | None = None
    #: The auto-exposure scene the live settings were chosen for.
    scene: str | None = None
    baseline: Baseline | None = None
    #: A corrective slew of the watch's is running.
    correcting: bool = False
    #: The disc measurement CENTERING (or a re-centre) corrects from.
    disc: Disc | None = None
    #: The pointing moved while a live exposure was running, so its frame shows the
    #: sky in between and is dropped rather than stacked.
    live_exposure_stale: bool = False
    #: The watchdog has aborted the exposure and the link is not yet back. No
    #: exposure is started while this holds; the one that was running is gone.
    capture_suspended: bool = False
    #: The CAPTURE command this run is being kept for, and the profile it named.
    #: Both None on a mission nobody has pressed Capture on -- the mission still
    #: runs the state machine, and PROCESSING has nothing to deliver.
    capture_command_id: str | None = None
    imaging_profile: ImagingProfile | None = None
    #: The stack as it stood after the last accepted frame. Kept because
    #: `LiveStack` has no way to hand back the current stack without being given
    #: another exposure, and PROCESSING has no further exposure to give it.
    stacked: Frame | None = None
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
        max_observing_seconds: float = MAX_OBSERVING_SECONDS,
        show: Callable[[Frame], None] | None = None,
        stack: LiveStack | None = None,
        on_capture: Callable[[FinishedCapture], None] | None = None,
    ) -> None:
        self._devices = devices
        self._envelope = envelope
        self._solver = solver
        self._clock = clock or SystemClock()
        self._emit = emit or (lambda event: None)
        self._idle_park_seconds = idle_park_seconds
        self._max_observing_seconds = max_observing_seconds
        # A fitted sky sensor reporting cloud (ADR-080 §2). None is fitted in Phase 1.
        self._sky_cloudy = False
        # Every frame the camera returns is offered to the live view, whatever the
        # runner wanted it for. A customer watching during VERIFYING should see the
        # sky the plate solver is looking at, not a blank panel until CAPTURING --
        # and the frame that failed to solve is the one that explains why the
        # mission is taking a while. What reaches the wire is decided downstream.
        self._show = show or (lambda frame: None)
        # Not `stack or LiveStack()`: an injected stack must not be discarded, and
        # a caller passing one is usually a test that means to inspect it.
        self._stack = LiveStack() if stack is None else stack
        # Handed the finished image at PROCESSING. Like `emit`, it must not block:
        # this is called while the device lock is held.
        self._on_capture = on_capture or (lambda capture: None)

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

    @property
    def current_target_id(self) -> uuid.UUID | None:
        """The object of the GOTO or RETARGET the agent last accepted."""
        return self._progress.request.target_id if self._progress else None

    @property
    def capture_pending(self) -> bool:
        """A CAPTURE has been accepted and not yet delivered."""
        progress = self._progress
        return progress is not None and (
            progress.capture_command_id is not None
            or self._state in {MissionState.capturing, MissionState.processing}
        )

    @property
    def watch(self) -> ImageWatch | None:
        return self._progress.watch if self._progress else None

    def image_health(self) -> dict | None:
        """The contract's ImageHealth while OBSERVING, else None (ADR-080 §2)."""
        progress = self._progress
        if progress is None or progress.watch is None or self._state is not MissionState.observing:
            return None
        return progress.watch.health()

    def dwell_allowed_at(self) -> datetime | None:
        """When the mount may leave the current object (ADR-079 §4)."""
        progress = self._progress
        if progress is None or progress.dwell_started_at is None:
            return None
        return progress.dwell_started_at + timedelta(seconds=DWELL_SECONDS)

    def dwell_locked(self, at_time: datetime) -> bool:
        """The agent's own dwell lock: 600 s less 15 s of skew, waived when the
        picture is UNRECOVERED or the current object has left the envelope."""
        allowed = self.dwell_allowed_at()
        if allowed is None:
            return False
        if at_time >= allowed - timedelta(seconds=DWELL_SKEW_TOLERANCE_SECONDS):
            return False
        progress = self._require_progress()
        if progress.watch is not None and progress.watch.unrecovered:
            return False
        return self._current_target_permitted(at_time)

    def seconds_left(self, at_time: datetime) -> float | None:
        """Until the observing deadline, or None if there is none yet."""
        progress = self._progress
        if progress is None:
            return None
        left: float | None = None
        if progress.session_end is not None:
            left = (progress.session_end - at_time).total_seconds()
        if progress.observing_since_monotonic is not None:
            ceiling = self._max_observing_seconds - (
                self._clock.monotonic() - progress.observing_since_monotonic
            )
            left = ceiling if left is None else min(left, ceiling)
        return left

    def set_session_end(self, ends_at: datetime | None) -> None:
        """The session's `expiresAt`: the observing deadline (ADR-079 §2).

        Only ever brought forward or set. A null update is a revocation or a
        rotation, not a new deadline, so it leaves the one already known standing.
        """
        progress = self._progress
        if progress is None or ends_at is None:
            return
        progress.session_end = ends_at

    def end_session(self, at_time: datetime) -> None:
        """The cloud says the slot has ended (SLOT_ENDED): finish now."""
        progress = self._progress
        if progress is None or not self.is_active:
            return
        if progress.session_end is None or progress.session_end > at_time:
            progress.session_end = at_time

    def set_sky_cloudy(self, cloudy: bool) -> None:
        self._sky_cloudy = cloudy

    # ------------------------------------------------------------------
    # Accepting work
    # ------------------------------------------------------------------

    def set_envelope(self, envelope: SafetyEnvelope) -> None:
        """Adopt a newly measured envelope for the next mission.

        A mission already under way keeps the envelope it was admitted under.
        Re-judging it halfway would mean a slew that was permitted when it started
        becoming a failure mid-motion, which is not safer -- the mount is already
        there -- and would lose the record of what it was actually checked against.
        """
        self._envelope = envelope

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
            aim=(request.right_ascension_hours, request.declination_degrees),
            started_at=at_time,
            state_entered_monotonic=self._clock.monotonic(),
            live_exposure_milliseconds=request.exposure_milliseconds,
            live_gain=request.gain,
            dwell_started_at=at_time,
        )
        self._failure_reason = None
        self._transition(MissionState.preparing, at_time)

    def cancel(self, at_time: datetime, reason: MissionFailureReason) -> None:
        """End the mission early. Parks, like every other terminal path."""
        if not self.is_active:
            return
        self._fail(MissionState.cancelled, reason, at_time, "cancelled")

    def suspend_capture(self) -> None:
        """The watchdog has aborted the exposure. Hold until the link is back.

        The runner cannot tell on its own: `SimCamera.exposure_complete()` is
        False forever after an abort, and a real camera answers the same way, so
        a runner left waiting for that exposure would wait for the rest of the
        night with the mount tracking. Forgetting the exposure means the next
        pump after `resume_capture` starts a fresh one, and holding means it does
        not start one while the watchdog still wants capture stopped.
        """
        progress = self._progress
        if progress is None:
            return
        progress.exposure_started = False
        progress.job = None
        progress.capture_suspended = True

    def resume_capture(self) -> None:
        progress = self._progress
        if progress is not None:
            progress.capture_suspended = False

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
            if self._past_deadline(at_time) and self._finish_session(at_time):
                return
            handler(at_time)
        except DeviceError as error:
            self._fail(
                MissionState.hardware_error,
                fault_reason(error),
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
            at_time,
            horizontal.altitude_degrees,
            horizontal.azimuth_degrees,
            operator_override=request.operator_override,
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
        # The stack belongs to where the mount was pointing. Carrying it across a
        # slew would average two different parts of the sky into one image, which
        # is not a worse picture of the target -- it is a picture of nothing.
        self._stack.reset()
        self._devices.mount.slew_to(altitude, azimuth)
        if hasattr(self._solver, "set_commanded_position"):
            self._solver.set_commanded_position(*progress.aim)
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

        if progress.capture_suspended:
            return
        if not progress.exposure_started:
            self._devices.camera.expose(*self._solve_settings())
            progress.exposure_started = True
            return

        if not self._devices.camera.exposure_complete():
            return

        frame = self._devices.camera.read_frame()
        self._show(frame)
        progress.exposure_started = False
        progress.solve_attempts += 1

        offset = self._measure(frame)
        if offset is None:
            # Criterion 4: bounded attempts, and never a fourth.
            if progress.solve_attempts >= MAX_SOLVE_ATTEMPTS:
                if progress.acquired:
                    self._enter_observing(at_time, gave_up=ImageHealthReason.off_centre)
                    return
                self._fail(
                    MissionState.failed,
                    MissionFailureReason.plate_solve_failed,
                    at_time,
                    f"{progress.solve_attempts} consecutive plate solves failed",
                )
            return

        if offset <= self._centred_tolerance(frame):
            self._enter_observing(at_time)
            return

        if progress.acquired:
            # A retargeted object that cannot be centred is not a failed session
            # (ADR-080 §3). Decided here, because CENTERING may only lead back to
            # SLEWING, and OBSERVING is reached only from VERIFYING.
            correction = (
                "centring iterations are exhausted"
                if progress.centering_iterations >= MAX_CENTERING_ITERATIONS
                else self._correction(at_time)
            )
            if isinstance(correction, str):
                logger.warning("retargeted object not centred: %s", correction)
                self._enter_observing(at_time, gave_up=ImageHealthReason.off_centre)
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

        correction = self._correction(at_time)
        if isinstance(correction, str):
            if correction.startswith("a correction to declination"):
                reason = MissionFailureReason.centering_iterations_exhausted
            elif not self._envelope.is_measured:
                reason = MissionFailureReason.safety_envelope_unmeasured
            else:
                reason = MissionFailureReason.safety_refused
            self._fail(MissionState.failed, reason, at_time, correction)
            return

        altitude, azimuth, aim = correction
        progress.aim = aim
        self._begin_slew(altitude, azimuth, at_time)

    # ------------------------------------------------------------------
    # Measuring where the object is
    # ------------------------------------------------------------------

    def _disc_profile(self) -> bool:
        return is_disc(self._require_progress().request.imaging_profile)

    def _solve_settings(self) -> tuple[float, int]:
        """A plate solve at the request's exposure; a disc at the live view's.

        The Moon at a two-second plate-solve exposure is a white rectangle with no
        centroid worth measuring.
        """
        progress = self._require_progress()
        if self._disc_profile():
            return progress.live_exposure_milliseconds, progress.live_gain
        return progress.request.exposure_milliseconds, progress.request.gain

    def _degrees_per_pixel(self, frame: Frame) -> float:
        optical = self._require_progress().request.optical_config
        return field_height_degrees(optical) / frame.height_px

    def _measure(self, frame: Frame) -> float | None:
        """How far the object is from where it should be, in degrees, or None.

        Deep sky: a plate solve against the target. Moon and planet: the bright
        disc's centroid against the frame centre (ADR-080 §5) -- a frame with no
        disc is None, which is OFF_CENTRE to the watch, not a solve failure.
        """
        progress = self._require_progress()
        if self._disc_profile():
            found = disc_centroid(frame)
            progress.disc = found
            if found is None:
                return None
            return math.hypot(found.dx_px, found.dy_px) * self._degrees_per_pixel(frame)

        solved = self._solver.solve(frame)
        progress.solved = solved
        if solved is None:
            return None
        request = progress.request
        return separation_degrees(
            solved.right_ascension_hours,
            solved.declination_degrees,
            request.right_ascension_hours,
            request.declination_degrees,
        )

    def _centred_tolerance(self, frame: Frame) -> float:
        if self._disc_profile():
            return (
                DISC_CENTRED_FIELD_FRACTION
                * min(frame.height_px, frame.width_px)
                * self._degrees_per_pixel(frame)
            )
        return CENTERING_TOLERANCE_DEGREES

    def _off_centre_limit(self, frame: Frame) -> float:
        if self._disc_profile():
            return (
                OFF_CENTRE_FIELD_FRACTION
                * min(frame.height_px, frame.width_px)
                * self._degrees_per_pixel(frame)
            )
        optical = self._require_progress().request.optical_config
        return max(
            OFF_CENTRE_MIN_DEGREES, OFF_CENTRE_FIELD_FRACTION * field_height_degrees(optical)
        )

    def _correction(
        self, at_time: datetime
    ) -> tuple[float, float, tuple[float, float]] | str:
        """Where to send the mount to take out the measured offset, or why not.

        Returns (altitude, azimuth, aim). A corrected position is a position
        nobody has checked: it is near the target, and near is not inside the
        envelope, so it is judged like any other slew.
        """
        progress = self._require_progress()
        request = progress.request

        if self._disc_profile():
            # The disc's offset is in the camera's frame. The simulator's camera is
            # square to the alt-az axes (up is +altitude); the real camera's
            # rotation is a first-light measurement (DV-035).
            found = progress.disc
            assert found is not None
            status = self._devices.mount.status()
            scale = field_height_degrees(request.optical_config) / self._frame_height()
            altitude = status.altitude_degrees - found.dy_px * scale
            cos_alt = max(0.05, math.cos(math.radians(status.altitude_degrees)))
            azimuth = (status.azimuth_degrees + found.dx_px * scale / cos_alt) % 360.0
            aim = progress.aim
        else:
            # The mount landed `solved` when sent to `aim`. Sending it to `aim`
            # again lands it in the same wrong place; sending it as far the other
            # way as it missed by lands it on the target.
            solved = progress.solved
            assert solved is not None
            aim_ra, aim_dec = progress.aim
            corrected_ra = (
                aim_ra + request.right_ascension_hours - solved.right_ascension_hours
            ) % 24.0
            corrected_dec = aim_dec + request.declination_degrees - solved.declination_degrees
            if not -90.0 <= corrected_dec <= 90.0:
                return (
                    f"a correction to declination {corrected_dec:.2f} is past the pole; "
                    "the solve and the target disagree by more than centring can fix"
                )
            horizontal = equatorial_to_horizontal(
                corrected_ra, corrected_dec, at_time, self._envelope.site
            )
            altitude, azimuth = horizontal.altitude_degrees, horizontal.azimuth_degrees
            aim = (corrected_ra, corrected_dec)

        verdict = self._envelope.evaluate_pointing(
            at_time, altitude, azimuth, operator_override=request.operator_override
        )
        if not verdict.permitted:
            return verdict.detail
        return altitude, azimuth, aim

    def _frame_height(self) -> int:
        return self._devices.camera.status().height_px

    def _current_target_permitted(self, at_time: datetime) -> bool:
        request = self._require_progress().request
        if self._envelope.site is None:
            return False
        horizontal = equatorial_to_horizontal(
            request.right_ascension_hours, request.declination_degrees, at_time, self._envelope.site
        )
        return self._envelope.evaluate_pointing(
            at_time,
            horizontal.altitude_degrees,
            horizontal.azimuth_degrees,
            operator_override=request.operator_override,
        ).permitted

    def request_capture(
        self, command_id: str, profile: ImagingProfile, settings: Profile
    ) -> bool:
        """Keep the run that is about to happen. Returns whether it was accepted.

        A booked session may capture many times (ADR-079 §3): each CAPTURE takes
        the mission OBSERVING -> CAPTURING -> PROCESSING and, while the slot runs,
        back to OBSERVING. The capture runs at the profile's settings; the live
        view's own exposure is left as auto exposure set it.

        Refused once a run has started. Changing the exposure halfway through
        would leave a stack averaged from two different exposures, which is not a
        capture of anything.
        """
        progress = self._progress
        if progress is None or self._state in TERMINAL_STATES:
            return False
        if self._state in {MissionState.capturing, MissionState.processing}:
            return False

        progress.capture_command_id = command_id
        progress.imaging_profile = profile
        progress.capture_settings = settings
        # A stack built from the frames the plate solver was looking at is a
        # stack of a different exposure at a different gain. The run starts here.
        self._stack.reset()
        progress.frames_captured = 0
        progress.exposure_started = False
        progress.stacked = None
        # An auto-exposure run would be measuring a picture nobody is keeping.
        progress.auto_exposure = None
        logger.info(
            "capture requested for mission %s: %s, %d x %.0fms at gain %d",
            progress.request.mission_id,
            profile.value,
            settings.frames,
            settings.exposure_milliseconds,
            settings.gain,
        )
        return True

    def request_focus(self, position: int | None) -> str | None:
        """Autofocus, or move the focuser to `position`. Returns why not, or None.

        Only while OBSERVING. It is the one state where the camera is free and the
        mount is on a field of stars; before it the plate solver owns the camera,
        after it the capture run does, and a focus change halfway through a stack
        would average sharp frames with soft ones.
        """
        progress = self._progress
        if progress is None or self._state is not MissionState.observing:
            return f"focus is only changed while observing; the mission is {self._state.value}"
        if progress.focus is not None:
            return "a focus change is already in progress"

        if position is None:
            progress.focus = Autofocus(
                self._devices.focuser,
                self._devices.camera,
                exposure_milliseconds=progress.live_exposure_milliseconds,
                gain=progress.live_gain,
                show=self._show,
            )
        else:
            progress.focus = FocusMove(self._devices.focuser, position)
        logger.info(
            "focus requested for mission %s: %s",
            progress.request.mission_id,
            "autofocus" if position is None else f"move to {position}",
        )
        return None

    def pointing_changed(self, *, nudged: bool = False) -> None:
        """The mount was moved under a running mission: a nudge or a recentre.

        The stack so far is of the old field, and averaging it with the new one is a
        picture of nothing, so it starts again; a live exposure already running is
        of the sky in between and is dropped when it finishes.

        A nudge is the customer framing the object their way, so the watch stops
        re-centring it until RECENTER or RETARGET puts the mount back on target.
        """
        progress = self._progress
        if progress is None or self._state is not MissionState.observing:
            return
        self._stack.reset()
        progress.stacked = None
        progress.baseline = None
        if progress.job is not None:
            progress.live_exposure_stale = True
        if nudged and progress.watch is not None:
            progress.watch.customer_moved()

    def returned_to_target(self, at_time: datetime) -> None:
        """RECENTER put the mount back on the current object: re-arm the watch.

        It does not restart the dwell lock (ADR-079 §4).
        """
        progress = self._progress
        if progress is None:
            return
        request = progress.request
        progress.aim = (request.right_ascension_hours, request.declination_degrees)
        if hasattr(self._solver, "set_commanded_position"):
            self._solver.set_commanded_position(*progress.aim)
        self.pointing_changed()
        if progress.watch is not None:
            progress.watch.reset(at_time, self._clock.monotonic())

    def retarget(
        self,
        target_id: uuid.UUID,
        right_ascension_hours: float,
        declination_degrees: float,
        profile: ImagingProfile,
        optical_config: OpticalConfig,
        at_time: datetime,
    ) -> str | None:
        """Move a live session to another object (ADR-079 §4). Returns why not, or None.

        The supervisor has already checked what the cloud's refusal reasons name.
        This checks only what the runner alone can: that it is OBSERVING with
        nothing in hand, and that the new object is inside the envelope now.
        """
        progress = self._progress
        if progress is None or self._state is not MissionState.observing:
            return f"the mission is {self._state.value}, not observing"
        if self.capture_pending or progress.focus is not None:
            return "a capture or a focus change is in progress"
        if self._devices.mount.status().slewing:
            return "the mount is slewing"
        if self._envelope.site is None:
            return "observatory coordinates are not configured"

        horizontal = equatorial_to_horizontal(
            right_ascension_hours, declination_degrees, at_time, self._envelope.site
        )
        verdict = self._envelope.evaluate_pointing(
            at_time,
            horizontal.altitude_degrees,
            horizontal.azimuth_degrees,
            operator_override=progress.request.operator_override,
        )
        if not verdict.permitted:
            return verdict.detail

        # Nothing of the old object's survives: its exposure, its stack, its
        # verdict, its offsets.
        if progress.job is not None:
            self._devices.camera.abort_exposure()
            progress.job = None
        settings = profiles.PROFILES[profile]
        progress.request = replace(
            progress.request,
            target_id=target_id,
            right_ascension_hours=right_ascension_hours,
            declination_degrees=declination_degrees,
            imaging_profile=profile,
            optical_config=optical_config,
            exposure_milliseconds=settings.exposure_milliseconds,
            gain=settings.gain,
        )
        progress.live_exposure_milliseconds = settings.exposure_milliseconds
        progress.live_gain = settings.gain
        progress.aim = (right_ascension_hours, declination_degrees)
        progress.centering_iterations = 0
        progress.solve_attempts = 0
        progress.solved = None
        progress.disc = None
        progress.auto_exposure = None
        progress.correcting = False
        progress.baseline = None
        progress.scene = None
        progress.stacked = None
        progress.live_exposure_stale = False
        progress.dwell_started_at = at_time
        logger.info(
            "retarget for mission %s to %s (%s)",
            progress.request.mission_id,
            target_id,
            profile.value,
        )
        self._begin_slew(horizontal.altitude_degrees, horizontal.azimuth_degrees, at_time)
        return None

    def _enter_observing(
        self, at_time: datetime, gave_up: ImageHealthReason | None = None
    ) -> None:
        """On the object: the live view runs, and the watch starts looking."""
        progress = self._require_progress()
        progress.acquired = True
        progress.exposure_started = False
        if progress.observing_since_monotonic is None:
            progress.observing_since_monotonic = self._clock.monotonic()
        self._transition(MissionState.observing, at_time)

        mono = self._clock.monotonic()
        disc = self._disc_profile()
        if progress.watch is None:
            progress.watch = ImageWatch(at_time, mono, disc=disc)
        else:
            progress.watch.reset(at_time, mono, disc=disc)
        progress.baseline = None
        progress.scene = None
        if gave_up is not None:
            progress.watch.give_up(gave_up, at_time, mono)
            return
        # Auto exposure after each acquisition (ADR-080 §1).
        profile = progress.request.imaging_profile
        if profile is not None:
            progress.auto_exposure = AutoExposure(
                profile, progress.live_exposure_milliseconds, progress.live_gain
            )

    def _do_observing(self, at_time: datetime) -> None:
        """Hold on the object with the live view running, for the rest of the slot.

        The one state in the machine that waits for a person. Everything before
        it is the observatory getting ready and everything after it is the
        observatory finishing; this is the part the customer is here for.

        The camera does one thing at a time, and the order is fixed: the exposure
        already running finishes; a focus run, then a capture request, go first;
        a corrective slew is waited out; then the watch (ADR-080) may ask for an
        auto-exposure try, a solve or a re-centre, and otherwise the next live
        frame is taken.
        """
        progress = self._require_progress()

        if progress.job is not None:
            if not self._devices.camera.exposure_complete():
                return
            self._finish_job(at_time)

        # A capture requested mid-focus waits for it.
        if progress.focus is not None:
            outcome = progress.focus.pump()
            if not outcome:
                return
            if isinstance(outcome, FocusResult):
                logger.info("focus finished: %s", outcome.detail)
            progress.focus = None
            # The stack so far was built at the old focus.
            self._stack.reset()
            progress.stacked = None
            progress.baseline = None

        if progress.capture_command_id is not None:
            self._transition(MissionState.capturing, at_time)
            return

        if progress.capture_suspended or self._devices.mount.status().slewing:
            return
        if progress.correcting:
            progress.correcting = False
            self._stack.reset()
            progress.stacked = None
            progress.baseline = None
            if progress.watch is not None:
                progress.watch.recentred()

        self._next_job(at_time)

    def _next_job(self, at_time: datetime) -> None:
        progress = self._require_progress()
        if progress.auto_exposure is not None:
            self._start_job("ae", *progress.auto_exposure.settings)
            return

        need = progress.watch.due(at_time, self._clock.monotonic()) if progress.watch else None
        if need is Need.AUTO_EXPOSE and progress.request.imaging_profile is not None:
            progress.auto_exposure = AutoExposure(
                progress.request.imaging_profile,
                progress.live_exposure_milliseconds,
                progress.live_gain,
            )
            self._start_job("ae", *progress.auto_exposure.settings)
            return
        if need is Need.AUTO_EXPOSE:
            # No profile, so no scene to expose for: the step is done.
            assert progress.watch is not None
            progress.watch.auto_exposed()
        elif need is Need.SOLVE:
            self._start_job("solve", *self._solve_settings())
            return
        elif need is Need.RECENTRE:
            self._recentre(at_time)
            return

        self._start_job("live", progress.live_exposure_milliseconds, progress.live_gain)

    def _start_job(self, job: str, exposure_milliseconds: float, gain: int) -> None:
        progress = self._require_progress()
        self._devices.camera.expose(exposure_milliseconds, gain)
        progress.job = job
        progress.job_settings = (exposure_milliseconds, gain)

    def _finish_job(self, at_time: datetime) -> None:
        """Read the exposure that just finished and do with it what it was for."""
        progress = self._require_progress()
        frame = self._devices.camera.read_frame()
        job, progress.job = progress.job, None
        stale = progress.live_exposure_stale or self._devices.mount.status().slewing
        progress.live_exposure_stale = False

        if job == "live":
            # A frame taken for a view nobody will see any more, or of a moving
            # field, is not stacked: a focus or capture run starts from a reset
            # stack anyway.
            if stale or progress.focus is not None or progress.capture_command_id is not None:
                return
            stacked = self._stack.add(frame)
            self._show(stacked.frame)
            progress.stacked = stacked.frame
            self._judge(frame, at_time)
            return

        self._show(frame)
        if stale:
            return
        if job == "ae":
            self._feed_auto_exposure(frame)
        elif job == "solve":
            self._finish_solve(frame, at_time)

    def _judgeable(self, frame: Frame) -> bool:
        return min(frame.height_px, frame.width_px) >= MIN_JUDGED_FRAME_PX

    def _feed_auto_exposure(self, frame: Frame) -> None:
        progress = self._require_progress()
        run = progress.auto_exposure
        if run is None:
            return
        if self._judgeable(frame) and not run.feed(stats(frame)):
            return
        progress.auto_exposure = None
        if run.scene is not None:
            progress.live_exposure_milliseconds, progress.live_gain = run.settings
            progress.scene = run.scene
        logger.info(
            "auto exposure: %s, %.3gms at gain %d after %d tries",
            run.scene,
            progress.live_exposure_milliseconds,
            progress.live_gain,
            run.tries,
        )
        # The stack and the cloud baseline were of another exposure.
        self._stack.reset()
        progress.stacked = None
        progress.baseline = None
        if progress.watch is not None:
            progress.watch.auto_exposed()

    def _finish_solve(self, frame: Frame, at_time: datetime) -> None:
        progress = self._require_progress()
        watch = progress.watch
        if watch is None:
            return
        offset = self._measure(frame)
        raised = False
        if offset is None and progress.baseline is not None and self._judgeable(frame):
            raised = stats(frame).bg >= CLOUD_BACKGROUND_RATIO * progress.baseline.bg
        watch.solved(
            offset,
            self._off_centre_limit(frame),
            at_time,
            self._clock.monotonic(),
            background_raised=raised,
        )

    def _judge(self, frame: Frame, at_time: datetime) -> None:
        """One live frame's health (ADR-080 §2), handed to the watch."""
        progress = self._require_progress()
        watch = progress.watch
        if watch is None or not self._judgeable(frame):
            return
        measured = stats(frame)
        disc = self._disc_profile()
        off_centre = False
        if disc and not watch.framing_held:
            found = disc_centroid(frame)
            off_centre = found is None or (
                math.hypot(found.dx_px, found.dy_px)
                > OFF_CENTRE_FIELD_FRACTION * min(frame.height_px, frame.width_px)
            )
        reason = judge(
            measured,
            disc=disc,
            off_centre=off_centre,
            baseline=progress.baseline,
            exposure_milliseconds=progress.live_exposure_milliseconds,
            gain=progress.live_gain,
            sky_cloudy=self._sky_cloudy,
        )
        if reason is None and progress.baseline is None and not watch.recovering:
            progress.baseline = Baseline(
                stars=measured.stars,
                bg=measured.bg,
                peak=measured.peak,
                exposure_milliseconds=progress.live_exposure_milliseconds,
                gain=progress.live_gain,
            )
        profile = progress.request.imaging_profile
        drift = (
            reason is None
            and profile is not None
            and progress.scene is not None
            and drifted(measured, progress.scene, SCENE_FOR_PROFILE[profile])
        )
        watch.frame(reason, at_time, self._clock.monotonic(), drift=drift)

    def _recentre(self, at_time: datetime) -> None:
        """A corrective slew of the measured offset (ADR-080 §3, RE_CENTRE).

        Through the envelope like any slew, never over one already running, and
        never without a measurement behind it: the watch asks for this only after
        a solve or a centroid found the offset.
        """
        progress = self._require_progress()
        watch = progress.watch
        assert watch is not None
        mono = self._clock.monotonic()
        measured = progress.disc if self._disc_profile() else progress.solved
        correction = (
            "nothing has been measured to correct from"
            if measured is None
            else self._correction(at_time)
        )
        if isinstance(correction, str):
            logger.warning("re-centre refused: %s", correction)
            watch.recentre_refused(at_time, mono)
            self._start_job("live", progress.live_exposure_milliseconds, progress.live_gain)
            return

        altitude, azimuth, aim = correction
        progress.aim = aim
        self._devices.mount.slew_to(altitude, azimuth)
        if hasattr(self._solver, "set_commanded_position"):
            self._solver.set_commanded_position(*aim)
        progress.correcting = True
        progress.solved = None
        progress.disc = None
        logger.info("re-centring mission %s", progress.request.mission_id)

    def _do_capturing(self, at_time: datetime) -> None:
        progress = self._require_progress()

        if progress.capture_suspended:
            return
        settings = progress.capture_settings
        exposure, gain = (
            (settings.exposure_milliseconds, settings.gain)
            if settings is not None
            else (progress.live_exposure_milliseconds, progress.live_gain)
        )
        if not progress.exposure_started:
            self._devices.camera.expose(exposure, gain)
            progress.exposure_started = True
            return

        if not self._devices.camera.exposure_complete():
            return

        # Stacked, then shown. This is the difference between a live view and a
        # webcam: the customer watches the same picture get better rather than
        # watching a fresh noisy sub replace the last one. `LiveStack` returns the
        # stack as it stands even when it refuses a frame, so a satellite crossing
        # the field costs a second of improvement rather than blanking the view.
        stacked = self._stack.add(self._devices.camera.read_frame())
        self._show(stacked.frame)
        progress.stacked = stacked.frame
        progress.exposure_started = False
        progress.frames_captured += 1

        requested = settings.frames if settings is not None else progress.request.requested_frames
        if progress.frames_captured >= requested:
            self._transition(MissionState.processing, at_time)

    def _do_processing(self, at_time: datetime) -> None:
        """Hand over the finished stack, then observe on, or finish at the slot's end.

        The capture is offered before anything else, so the mission cannot reach
        a terminal state with an image still nobody's responsibility. It is
        offered exactly once: `capture_command_id` is cleared as it goes.

        A failure here does not fail the mission. The customer watched the sky
        for the length of their slot; losing the keepsake is bad, and telling
        them the observation itself failed would be worse and untrue.
        """
        self._deliver_capture()
        progress = self._require_progress()
        if self._past_deadline(at_time):
            self._complete(at_time)
            return
        # The slot runs on (ADR-079 §5: PROCESSING -> OBSERVING).
        self._stack.reset()
        progress.stacked = None
        progress.capture_settings = None
        progress.imaging_profile = None
        progress.exposure_started = False
        progress.baseline = None
        self._transition(MissionState.observing, at_time)

    def _complete(self, at_time: datetime) -> None:
        self._transition(MissionState.complete, at_time)
        self._park("mission complete")
        self._require_progress().completed_monotonic = self._clock.monotonic()

    def _past_deadline(self, at_time: datetime) -> bool:
        left = self.seconds_left(at_time)
        return left is not None and left <= 0

    def _finish_session(self, at_time: datetime) -> bool:
        """The slot has ended (ADR-079 §2). Returns whether the pump is done.

        An in-flight capture is flushed with the frames already stacked; with
        nothing in flight OBSERVING goes straight to COMPLETE. Only the edges the
        cloud's table allows are walked: a retarget still acquiring is brought
        back to OBSERVING through VERIFYING, never sideways. A mission that never
        reached its object did not observe, so it is cancelled, not completed.
        """
        progress = self._require_progress()
        state = self._state
        if not progress.acquired:
            self._fail(
                MissionState.cancelled,
                MissionFailureReason.session_expired,
                at_time,
                "the session ended before the object was acquired",
            )
            return True
        if state is MissionState.processing or state is MissionState.centering:
            return False  # PROCESSING delivers and completes; CENTERING's slew is aborted next
        if state is MissionState.capturing:
            logger.info(
                "slot ended mid-capture; delivering %d frame(s)", self._stack.frames_stacked
            )
            self._devices.camera.abort_exposure()
            progress.exposure_started = False
            self._transition(MissionState.processing, at_time)
            return True
        if state is MissionState.slewing:
            self._devices.mount.abort_slew()
            self._transition(MissionState.verifying, at_time)
            state = MissionState.verifying
        if state is MissionState.verifying:
            self._devices.camera.abort_exposure()
            progress.exposure_started = False
            self._transition(MissionState.observing, at_time)
        if progress.job is not None:
            self._devices.camera.abort_exposure()
            progress.job = None
        logger.info("slot ended; finishing mission %s", progress.request.mission_id)
        self._complete(at_time)
        return True

    def _deliver_capture(self) -> None:
        progress = self._require_progress()
        command_id = progress.capture_command_id
        stacked = progress.stacked

        if command_id is None or progress.imaging_profile is None:
            # Nobody pressed Capture. The mission ran, the customer watched, and
            # there is nothing to keep.
            return

        progress.capture_command_id = None

        if stacked is None or self._stack.frames_stacked == 0:
            logger.warning(
                "capture %s produced no stacked frame; nothing to deliver", command_id
            )
            return

        settings = progress.capture_settings
        try:
            self._on_capture(
                FinishedCapture(
                    mission_id=str(progress.request.mission_id),
                    command_id=command_id,
                    imaging_profile=progress.imaging_profile,
                    frame=stacked,
                    frames_stacked=self._stack.frames_stacked,
                    exposure_milliseconds=(
                        settings.exposure_milliseconds
                        if settings
                        else progress.live_exposure_milliseconds
                    ),
                    gain=settings.gain if settings else progress.live_gain,
                    captured_at=stacked.captured_at,
                    target_id=progress.request.target_id,
                )
            )
        except Exception as error:  # noqa: BLE001 - see the docstring above
            logger.error("could not hand over capture %s: %s", command_id, error)

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

        docs/ENGINEERING.md gives the order: "stop capture, halt unsafe motion, Park." It is
        an order, not a list. A mount that faults mid-slew is still slewing, and a
        Park issued while a slew is running asks the mount to do two things at
        once -- on real hardware that is how a slew keeps going toward whatever
        the envelope just refused. The exposure is stopped first for the same
        reason: a camera still integrating while the mount swings is a shutter
        open through the mount's own motion.

        Each step is attempted independently. A failure in one must not skip the
        ones after it, because the last of them is Park.

        Park is attempted even when the mount is faulted, because a mount that
        might respond should be asked. A failure here is recorded rather than
        raised: there is nothing further the runner could do about it, and losing
        the mission's outcome to a secondary error would be worse.
        """
        progress = self._progress
        if progress is None:
            return
        if progress.focus is not None:
            try:
                if isinstance(progress.focus, Autofocus):
                    progress.focus.cancel()
                else:
                    self._devices.focuser.halt()
            except Exception as error:
                logger.error("could not stop the focuser (%s): %s", why, error)
            progress.focus = None
        progress.job = None
        progress.auto_exposure = None
        progress.correcting = False
        try:
            self._devices.camera.abort_exposure()
        except Exception as error:
            logger.error("could not stop the exposure (%s): %s", why, error)
        try:
            self._devices.mount.abort_slew()
        except Exception as error:
            logger.error("could not halt the slew (%s): %s", why, error)
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
