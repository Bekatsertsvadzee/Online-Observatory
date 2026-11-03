"""The agent watching its own picture, and the ladder it climbs to fix it (ADR-080).

This module decides; it touches no device. The runner shows it every live frame's
verdict and the outcome of every step it ran, and asks it what to do next:
auto-expose, solve (a plate solve, or the disc centroid for the Moon and planets),
or re-centre. Keeping the decisions apart from the camera and the mount is what
lets each rule below be tested on its own, at a chosen instant.

Two rules run through it.

**One gust is not an incident.** A reason is reported only after it holds on three
consecutive frames and at least ten seconds, and the picture is called good again
after two good frames.

**It never fights the mount.** At most six corrective slews in any ten minutes, a
disc correction at most every thirty seconds, no slew without a successful solve
behind it, and after two failed passes it stops moving the mount for this object
(UNRECOVERED) rather than trying again and again. The runner adds the rest: no
correction while capturing, none while a slew runs, every one through the envelope.

PROVISIONAL: every number is ADR-080's and none was measured. DV-035 sets them.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

from contracts.models import ImageHealthReason, ImageHealthStatus, RecoveryStep
from darkview_agent.capture.scene import FrameStats
from darkview_agent.clock import wire_timestamp

HEALTH_DEBOUNCE_FRAMES = 3
HEALTH_DEBOUNCE_SECONDS = 10.0
GOOD_FRAMES_TO_CLEAR = 2
CLOUD_RETRY_SECONDS = 120.0
LADDER_PASSES = 2
UNRECOVERED_RECHECK_SECONDS = 300.0
PERIODIC_RESOLVE_SECONDS = 300.0
CENTROID_CORRECTION_MIN_INTERVAL_SECONDS = 30.0
MAX_CORRECTIVE_SLEWS = 6
CORRECTIVE_SLEW_WINDOW_SECONDS = 600.0
MAX_RECENTRE_ITERATIONS = 3
#: Auto exposure re-runs when the picture leaves its goal on this many checks running.
AUTO_EXPOSE_DRIFT_CHECKS = 2
#: A solve that failed this often with the background raised is cloud, not aim.
SOLVE_FAILURES_MEANING_CLOUD = 2

BLANK_SPREAD = 0.02
OVEREXPOSED_CLIP = 0.25
DISC_OVEREXPOSED_CLIP = 0.02
DISC_OVEREXPOSED_BLOB = 0.02
MIN_STARS = 3
CLOUD_STAR_FRACTION = 0.3
CLOUD_BACKGROUND_RATIO = 1.5
CLOUD_DISC_PEAK_FRACTION = 0.4


class Need(StrEnum):
    """What the watch wants the runner to do next."""

    AUTO_EXPOSE = "AUTO_EXPOSE"
    SOLVE = "SOLVE"
    RECENTRE = "RECENTRE"


@dataclass(frozen=True)
class Baseline:
    """The picture as it was when the object was acquired, for the cloud test."""

    stars: int
    bg: float
    peak: float
    exposure_milliseconds: float
    gain: int


def judge(
    m: FrameStats,
    *,
    disc: bool,
    off_centre: bool,
    baseline: Baseline | None,
    exposure_milliseconds: float,
    gain: int,
    sky_cloudy: bool = False,
) -> ImageHealthReason | None:
    """One frame's verdict, by ADR-080 §2's table. None means the frame is good.

    `off_centre` is the disc centroid's verdict; a deep-sky frame's offset comes
    from a plate solve, not from here.
    """
    if m.peak - m.median < BLANK_SPREAD and m.stars == 0:
        return ImageHealthReason.blank_frame
    if m.clip > OVEREXPOSED_CLIP or (
        disc and m.clip > DISC_OVEREXPOSED_CLIP and m.blob > DISC_OVEREXPOSED_BLOB
    ):
        return ImageHealthReason.overexposed
    if sky_cloudy:
        return ImageHealthReason.clouds
    raised = baseline is not None and m.bg >= CLOUD_BACKGROUND_RATIO * max(baseline.bg, 1e-6)
    if baseline is not None:
        if disc:
            same_settings = (
                baseline.exposure_milliseconds == exposure_milliseconds and baseline.gain == gain
            )
            if same_settings and m.peak < CLOUD_DISC_PEAK_FRACTION * baseline.peak:
                return ImageHealthReason.clouds
        elif baseline.stars > 0 and m.stars < CLOUD_STAR_FRACTION * baseline.stars and raised:
            return ImageHealthReason.clouds
    if not disc and m.stars < MIN_STARS and not raised:
        return ImageHealthReason.no_stars
    if disc and off_centre:
        return ImageHealthReason.off_centre
    return None


def _first_rung(reason: ImageHealthReason) -> RecoveryStep:
    if reason is ImageHealthReason.off_centre:
        return RecoveryStep.re_solve
    return RecoveryStep.re_expose


_NEED_FOR_STEP = {
    RecoveryStep.re_expose: Need.AUTO_EXPOSE,
    RecoveryStep.re_solve: Need.SOLVE,
    RecoveryStep.re_centre: Need.RECENTRE,
}


class ImageWatch:
    """The verdict on one object's picture, and the next step towards a good one.

    Times are the runner's: `mono` paces everything, `at` (the observatory's wall
    clock) is only what `since` and `nextRetryAt` are reported in.
    """

    def __init__(self, at: datetime, mono: float, *, disc: bool) -> None:
        # Mount wear is the mount's, not the object's: the slew budget survives a
        # retarget, which is why it is not in `reset`.
        self._slews: deque[float] = deque()
        self._last_disc_correction: float | None = None
        self.reset(at, mono, disc=disc)

    def reset(self, at: datetime, mono: float, *, disc: bool | None = None) -> None:
        """A new object, or the customer put the mount back on it: start clean."""
        if disc is not None:
            self.disc = disc
        self.status = ImageHealthStatus.ok
        self.reason: ImageHealthReason | None = None
        self.step: RecoveryStep | None = None
        self.attempt: int | None = None
        self.since = at
        self._next_retry_mono: float | None = None
        self._next_retry_at: datetime | None = None
        self._streak = 0
        self._streak_since = 0.0
        self._good = 0
        self._drift_checks = 0
        self._pending: Need | None = None
        self._awaiting_frame = False
        self._recheck = False
        self._recentre_iterations = 0
        self._solve_failures = 0
        self._last_solve = mono
        self.latest_reason: ImageHealthReason | None = None
        #: The customer nudged the framing. Automatic re-centring would undo it,
        #: so it stops until RECENTER or RETARGET (`reset`).
        self.framing_held = False

    # ------------------------------------------------------------------
    # What the runner reads
    # ------------------------------------------------------------------

    @property
    def unrecovered(self) -> bool:
        return self.status is ImageHealthStatus.unrecovered

    @property
    def recovering(self) -> bool:
        return self.status is ImageHealthStatus.recovering

    def health(self) -> dict:
        """The contract's `ImageHealth`."""
        ok = self.status is ImageHealthStatus.ok
        if self.status is ImageHealthStatus.recovering:
            step = self.step
        elif self.status is ImageHealthStatus.waiting:
            step = RecoveryStep.wait_for_sky
        else:
            step = None
        timed = self.status in (ImageHealthStatus.waiting, ImageHealthStatus.unrecovered)
        return {
            "status": self.status.value,
            "reason": None if ok or self.reason is None else self.reason.value,
            "step": step.value if step else None,
            "attempt": None if ok else self.attempt,
            "since": wire_timestamp(self.since),
            "nextRetryAt": (
                wire_timestamp(self._next_retry_at)
                if timed and self._next_retry_at is not None
                else None
            ),
        }

    # ------------------------------------------------------------------
    # What the runner tells it
    # ------------------------------------------------------------------

    def frame(
        self,
        reason: ImageHealthReason | None,
        at: datetime,
        mono: float,
        *,
        drift: bool = False,
    ) -> None:
        """One live frame's verdict."""
        self.latest_reason = reason
        if reason is None:
            self._streak = 0
            self._good += 1
            if self.status is ImageHealthStatus.ok:
                self._drift_checks = self._drift_checks + 1 if drift else 0
                if self._drift_checks >= AUTO_EXPOSE_DRIFT_CHECKS and self._pending is None:
                    self._drift_checks = 0
                    self._pending = Need.AUTO_EXPOSE
                return
            if self._good >= GOOD_FRAMES_TO_CLEAR and self._clears_by_frames():
                self._ok(at)
            return

        self._good = 0
        if self.status is ImageHealthStatus.ok:
            if self._streak == 0:
                self._streak_since = mono
            self._streak += 1
            if (
                self._streak >= HEALTH_DEBOUNCE_FRAMES
                and mono - self._streak_since >= HEALTH_DEBOUNCE_SECONDS
            ):
                self._streak = 0
                self._start(reason, at, mono)
            return

        if self.status is ImageHealthStatus.recovering:
            if reason is ImageHealthReason.clouds:
                self._wait(at, mono)
                return
            if self._awaiting_frame:
                self._awaiting_frame = False
                if self.step is RecoveryStep.re_expose:
                    self._rung(RecoveryStep.re_solve)
                else:
                    self._pass_failed(at, mono)

    def auto_exposed(self) -> None:
        """An auto-exposure run finished."""
        if self._recheck:
            self._pending = Need.SOLVE
        elif self.status is ImageHealthStatus.recovering and self.step is RecoveryStep.re_expose:
            self._awaiting_frame = True

    def solved(
        self,
        offset_degrees: float | None,
        limit_degrees: float,
        at: datetime,
        mono: float,
        *,
        background_raised: bool = False,
    ) -> None:
        """A solve (or centroid) finished: the offset from the target, or None."""
        self._last_solve = mono
        centred = offset_degrees is not None and offset_degrees <= limit_degrees

        if self.status is ImageHealthStatus.ok:
            if offset_degrees is not None and not centred and not self.framing_held:
                self._start(ImageHealthReason.off_centre, at, mono, step=RecoveryStep.re_centre)
            return

        if self._recheck:
            self._recheck = False
            if offset_degrees is None:
                return
            if not centred:
                self._pending = Need.RECENTRE
            elif self.reason is ImageHealthReason.off_centre:
                self._ok(at)
            return

        if self.status is not ImageHealthStatus.recovering:
            return
        if offset_degrees is None:
            self._solve_failures += 1
            if self._solve_failures >= SOLVE_FAILURES_MEANING_CLOUD and background_raised:
                self._wait(at, mono)
                return
            self._pass_failed(at, mono)
            return
        if centred:
            if self.reason is ImageHealthReason.off_centre:
                self._ok(at)
            else:
                self._awaiting_frame = True
            return
        if self._recentre_iterations >= MAX_RECENTRE_ITERATIONS:
            self._pass_failed(at, mono)
            return
        self._rung(RecoveryStep.re_centre)

    def recentred(self) -> None:
        """The corrective slew finished. Verify it with another solve."""
        if self.status is ImageHealthStatus.recovering:
            self._rung(RecoveryStep.re_solve)
        else:
            self._recheck = True
            self._pending = Need.SOLVE

    def recentre_refused(self, at: datetime, mono: float) -> None:
        """The runner could not make the slew (envelope, or the mount was busy)."""
        if self._slews and self._slews[-1] == mono:
            self._slews.pop()
        if self.status is ImageHealthStatus.recovering:
            self._pass_failed(at, mono)

    def customer_moved(self) -> None:
        self.framing_held = True

    def give_up(self, reason: ImageHealthReason, at: datetime, mono: float) -> None:
        """A retargeted object would not solve or centre: UNRECOVERED at once.

        The acquisition already was the ladder's work, bounded the same way; it
        ends the attempt on this object without ending the session (ADR-080 §3).
        """
        self.reason = reason
        self.attempt = LADDER_PASSES
        self.step = None
        self._pending = None
        self._set(ImageHealthStatus.unrecovered, at)
        self._schedule(at, mono, UNRECOVERED_RECHECK_SECONDS)

    # ------------------------------------------------------------------
    # What to do now
    # ------------------------------------------------------------------

    def due(self, at: datetime, mono: float) -> Need | None:
        """The step to run now, if any. Call only with the camera and mount idle."""
        if self._pending is Need.RECENTRE:
            return self._take_recentre(at, mono)
        if self._pending is not None:
            need, self._pending = self._pending, None
            return need

        if (
            self.status is ImageHealthStatus.ok
            and not self.disc
            and not self.framing_held
            and mono - self._last_solve >= PERIODIC_RESOLVE_SECONDS
        ):
            self._last_solve = mono
            return Need.SOLVE

        if self._next_retry_mono is None or mono < self._next_retry_mono:
            return None

        if self.status is ImageHealthStatus.waiting:
            if self.latest_reason in (ImageHealthReason.clouds, None):
                self._schedule(at, mono, CLOUD_RETRY_SECONDS)
                return None
            self.reason = self.latest_reason
            self.attempt = 1
            self._set(ImageHealthStatus.recovering, at)
            self._rung(RecoveryStep.re_expose)
            return self.due(at, mono)

        if self.status is ImageHealthStatus.unrecovered:
            self._recheck = True
            self._schedule(at, mono, UNRECOVERED_RECHECK_SECONDS)
            return Need.AUTO_EXPOSE
        return None

    def _take_recentre(self, at: datetime, mono: float) -> Need | None:
        while self._slews and mono - self._slews[0] >= CORRECTIVE_SLEW_WINDOW_SECONDS:
            self._slews.popleft()
        if len(self._slews) >= MAX_CORRECTIVE_SLEWS:
            self._pending = None
            if self.status is ImageHealthStatus.recovering:
                self._pass_failed(at, mono)
            return None
        if (
            self.disc
            and self._last_disc_correction is not None
            and mono - self._last_disc_correction < CENTROID_CORRECTION_MIN_INTERVAL_SECONDS
        ):
            return None  # keep it pending; the interval passes on its own
        self._pending = None
        self._slews.append(mono)
        if self.disc:
            self._last_disc_correction = mono
        self._recentre_iterations += 1
        return Need.RECENTRE

    # ------------------------------------------------------------------
    # The ladder
    # ------------------------------------------------------------------

    def _clears_by_frames(self) -> bool:
        # A deep-sky offset is only ever known from a solve; frames that look
        # fine say nothing about where they are.
        return not (self.reason is ImageHealthReason.off_centre and not self.disc)

    def _set(self, status: ImageHealthStatus, at: datetime) -> None:
        if status is not self.status:
            self.status = status
            self.since = at

    def _schedule(self, at: datetime, mono: float, seconds: float) -> None:
        self._next_retry_mono = mono + seconds
        self._next_retry_at = at + timedelta(seconds=seconds)

    def _start(
        self,
        reason: ImageHealthReason,
        at: datetime,
        mono: float,
        step: RecoveryStep | None = None,
    ) -> None:
        self.reason = reason
        self.attempt = 1
        self._solve_failures = 0
        self._recentre_iterations = 0
        self._good = 0
        if reason is ImageHealthReason.clouds:
            self._wait(at, mono)
            return
        self._set(ImageHealthStatus.recovering, at)
        self._rung(step or _first_rung(reason))

    def _rung(self, step: RecoveryStep) -> None:
        self.step = step
        self._awaiting_frame = False
        self._pending = _NEED_FOR_STEP[step]

    def _wait(self, at: datetime, mono: float) -> None:
        self.reason = ImageHealthReason.clouds
        self.attempt = self.attempt or 1
        self.step = RecoveryStep.wait_for_sky
        self._pending = None
        self._awaiting_frame = False
        self._set(ImageHealthStatus.waiting, at)
        self._schedule(at, mono, CLOUD_RETRY_SECONDS)

    def _pass_failed(self, at: datetime, mono: float) -> None:
        assert self.reason is not None and self.attempt is not None
        if self.attempt >= LADDER_PASSES:
            self.step = None
            self._pending = None
            self._awaiting_frame = False
            self._set(ImageHealthStatus.unrecovered, at)
            self._schedule(at, mono, UNRECOVERED_RECHECK_SECONDS)
            return
        self.attempt += 1
        self._recentre_iterations = 0
        # Solve failures count across passes: two on a raised sky mean cloud.
        self._rung(_first_rung(self.reason))

    def _ok(self, at: datetime) -> None:
        self._set(ImageHealthStatus.ok, at)
        self.reason = None
        self.step = None
        self.attempt = None
        self._next_retry_mono = None
        self._next_retry_at = None
        self._pending = None
        self._awaiting_frame = False
        self._recheck = False
        self._streak = 0
        self._good = 0


__all__ = [
    "Baseline",
    "ImageWatch",
    "Need",
    "judge",
]
