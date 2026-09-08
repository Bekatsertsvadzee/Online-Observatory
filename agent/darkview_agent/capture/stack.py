"""Live stacking — what makes this EAA rather than a webcam.

A single 2-second sub of a globular cluster is mostly noise. Twenty of them
averaged together is a picture. The signal is the same in every frame and adds
linearly; the read and shot noise is different in every frame and adds as the
square root, so averaging N frames improves the signal-to-noise ratio by about
sqrt(N). That improvement, appearing live while somebody watches, is the whole
experience Phase 1 sells.

Two things have to be right or stacking makes the picture worse rather than
better:

**Frames must be aligned before they are averaged.** A tracking mount drifts.
Averaging a drifting star field smears every star into a streak, and the result
is a worse image than the single frame it started from. Alignment here is
translation only, recovered by phase correlation, which is the standard method
and needs no star detection, no catalogue and no calibration.

**A bad frame must not poison the stack.** A satellite trail, a gust that shook
the mount, or a cloud crossing the field arrives as one frame that does not
belong. Once averaged in it cannot be taken out, so the check happens before.

PROVISIONAL: every threshold below is measured against `SimCamera`, because the
real drift, seeing and cloud behaviour of the Tbilisi rooftop do not exist yet.
DV-035 replaces them with figures read off the ASI585MC. They are marked at each
definition. None of them is a safety value -- nothing here can move a telescope.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

from darkview_agent.devices.frame import Frame

logger = logging.getLogger("darkview.agent.stack")

#: PROVISIONAL. The largest shift, as a fraction of the frame, that is believed.
#:
#: Phase correlation always returns a peak, including for two frames that have
#: nothing in common -- it is a maximum, not a match. A shift larger than this is
#: taken as "these frames do not correspond" rather than as a real excursion: a
#: tracking mount that jumped an eighth of the field in one sub was knocked, and
#: the frame after the knock does not belong with the frames before it.
DEFAULT_MAX_SHIFT_FRACTION = 0.125

#: PROVISIONAL. How far a frame's background may move before it is rejected.
#:
#: Expressed as a multiple of the reference frame's own noise (MAD), so it scales
#: with the exposure and the sky rather than being an absolute ADU figure that
#: would mean different things at different gains. Cloud crossing the field raises
#: the background sharply; so does a car headlight on a rooftop.
DEFAULT_MAX_BACKGROUND_DRIFT_SIGMA = 6.0

#: Scales the median absolute deviation to a standard deviation for a normal
#: distribution. The same constant `stream/mjpeg.py` uses, and for the same
#: reason: the MAD is robust to the stars, which a plain standard deviation is not.
MAD_TO_SIGMA = 1.4826


class StackRejection(str):
    """Why a frame was not stacked. A string so it reads plainly in a log."""


REJECT_SHAPE = StackRejection("frame shape does not match the stack")
REJECT_SHIFT = StackRejection("alignment shift is too large to be tracking drift")
REJECT_BACKGROUND = StackRejection("background moved too far; cloud or stray light")


@dataclass(frozen=True)
class StackResult:
    """What one `add` did."""

    frame: Frame
    accepted: bool
    frames_stacked: int
    #: The (dy, dx) applied to bring this frame onto the reference. The mount's
    #: own drift is its negation, which is worth stating because the two are easy
    #: to confuse in a log and only one of them is what an operator wants to read.
    correction_yx: tuple[int, int] = (0, 0)
    rejection: str | None = None

    @property
    def drift_yx(self) -> tuple[int, int]:
        """How far the field moved between the reference frame and this one."""
        return (-self.correction_yx[0], -self.correction_yx[1])


def background_and_noise(pixels: np.ndarray) -> tuple[float, float]:
    """The sky level and its spread, robust to the stars in front of it.

    Median and MAD rather than mean and standard deviation. A frame is mostly sky
    with a few bright things on it, and the bright things drag a mean and inflate
    a standard deviation -- which is exactly backwards for a statistic meant to
    describe the sky.
    """
    data = pixels.astype(np.float64, copy=False)
    median = float(np.median(data))
    mad = float(np.median(np.abs(data - median)))
    return median, mad * MAD_TO_SIGMA


def align_shift(reference: np.ndarray, moving: np.ndarray) -> tuple[int, int]:
    """The whole-pixel (dy, dx) to apply to `moving` so it lands on `reference`.

    A **correction**, not a measurement: a field that drifted three rows down
    returns -3, because that is what has to be added to put it back. The two signs
    are easy to confuse, so `StackResult` carries the correction and offers the
    drift as a named property rather than leaving a caller to guess which it holds.

    Phase correlation: the cross-power spectrum of two images that differ by a
    translation has a phase ramp whose inverse transform is a single spike at that
    translation. It is used rather than star centroiding because it needs no star
    detection, no threshold and no assumption about how many stars are in frame --
    a field with one bright star and a field with two hundred both work.

    Whole pixels only. Sub-pixel alignment needs interpolation, interpolation
    needs a resampling kernel, and choosing one without a real optical train to
    judge it against would be guessing. It is DV-035's, and until then a whole
    pixel is smaller than the seeing disc anyway.
    """
    # Mean-subtracted, so the DC term does not dominate the correlation. Two
    # frames of the same sky share a large constant background, and without this
    # the spike at zero shift would swamp the real one.
    a = reference.astype(np.float64, copy=False)
    b = moving.astype(np.float64, copy=False)
    a = a - a.mean()
    b = b - b.mean()

    spectrum_a = np.fft.rfft2(a)
    spectrum_b = np.fft.rfft2(b)
    cross = spectrum_a * np.conj(spectrum_b)

    magnitude = np.abs(cross)
    # Normalised to unit magnitude: that is what makes it *phase* correlation. It
    # is what stops one very bright star deciding the answer on its own.
    with np.errstate(invalid="ignore", divide="ignore"):
        cross = np.where(magnitude == 0, 0, cross / np.where(magnitude == 0, 1, magnitude))

    correlation = np.fft.irfft2(cross, s=a.shape)
    peak = np.unravel_index(int(np.argmax(correlation)), correlation.shape)

    # The transform wraps, so a peak past the halfway point is a negative shift.
    height, width = a.shape
    dy = int(peak[0])
    dx = int(peak[1])
    if dy > height // 2:
        dy -= height
    if dx > width // 2:
        dx -= width
    return dy, dx


def shift_image(pixels: np.ndarray, dy: int, dx: int) -> np.ndarray:
    """Translate by whole pixels, filling what moves in with the frame's median.

    Filled with the median rather than with zeros. A zero-filled edge is a black
    band that the autostretch then reads as the darkest part of the sky, which
    drags the whole stretch and makes the picture flicker as frames drift.
    """
    if dy == 0 and dx == 0:
        return pixels

    filler = np.median(pixels)
    out = np.full_like(pixels, filler, dtype=pixels.dtype)

    source_y = slice(max(0, -dy), pixels.shape[0] - max(0, dy))
    target_y = slice(max(0, dy), pixels.shape[0] - max(0, -dy))
    source_x = slice(max(0, -dx), pixels.shape[1] - max(0, dx))
    target_x = slice(max(0, dx), pixels.shape[1] - max(0, -dx))

    out[target_y, target_x] = pixels[source_y, source_x]
    return out


class LiveStack:
    """A running average of aligned exposures, improving as frames arrive.

    **Mean, not sum.** A sum overflows 16 bits after two or three frames, and
    would also make the background climb linearly -- so the autostretch in
    `stream/mjpeg.py`, which anchors on the median, would be chasing a moving
    target and the live view would pulse. A mean keeps the frame on the same scale
    as a single exposure, so the same stretch works at frame one and frame fifty.

    The accumulator is float64. Averaging uint16 in uint16 loses the fractional
    part of every frame, which is precisely the sub-ADU information that averaging
    exists to recover.

    The first accepted frame is the reference every later frame is aligned to. Not
    a running reference: aligning each frame to the previous one lets small errors
    compound into a slow walk, which is the drift this is meant to remove.
    """

    def __init__(
        self,
        max_shift_fraction: float = DEFAULT_MAX_SHIFT_FRACTION,
        max_background_drift_sigma: float = DEFAULT_MAX_BACKGROUND_DRIFT_SIGMA,
    ) -> None:
        self._max_shift_fraction = max_shift_fraction
        self._max_background_drift_sigma = max_background_drift_sigma

        self._reference: np.ndarray | None = None
        self._reference_background: float = 0.0
        self._reference_noise: float = 0.0
        self._accumulator: np.ndarray | None = None
        self._count = 0
        self._rejected = 0

    @property
    def frames_stacked(self) -> int:
        return self._count

    @property
    def frames_rejected(self) -> int:
        return self._rejected

    def reset(self) -> None:
        """Start again. Called when the mount moves somewhere else.

        A stack that survived a slew would average two different parts of the sky
        into one image, which is not a worse picture of the target -- it is a
        picture of nothing.
        """
        self._reference = None
        self._accumulator = None
        self._count = 0
        self._rejected = 0

    def add(self, frame: Frame) -> StackResult:
        """Stack one exposure, or refuse it, and return the current stack.

        Always returns a frame. A rejected frame still leaves the customer looking
        at the stack as it stands rather than at nothing -- a live view that blanks
        because a satellite went past is worse than one that simply does not
        improve for a second.
        """
        if self._accumulator is None or self._reference is None:
            return self._begin(frame)

        if frame.pixels.shape != self._reference.shape:
            # A ROI change mid-mission. The stack is of a different picture now.
            self.reset()
            return self._begin(frame, previous_rejection=REJECT_SHAPE)

        background, _ = background_and_noise(frame.pixels)
        drift = abs(background - self._reference_background)
        if (
            self._reference_noise > 0
            and drift > self._max_background_drift_sigma * self._reference_noise
        ):
            return self._refuse(frame, REJECT_BACKGROUND)

        dy, dx = align_shift(self._reference, frame.pixels)
        limit_y = self._reference.shape[0] * self._max_shift_fraction
        limit_x = self._reference.shape[1] * self._max_shift_fraction
        if abs(dy) > limit_y or abs(dx) > limit_x:
            return self._refuse(frame, REJECT_SHIFT)

        self._accumulator += shift_image(frame.pixels, dy, dx).astype(np.float64)
        self._count += 1

        return StackResult(
            frame=self._current(frame),
            accepted=True,
            frames_stacked=self._count,
            correction_yx=(dy, dx),
        )

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _begin(self, frame: Frame, previous_rejection: str | None = None) -> StackResult:
        self._reference = frame.pixels.copy()
        self._reference_background, self._reference_noise = background_and_noise(
            frame.pixels
        )
        self._accumulator = frame.pixels.astype(np.float64)
        self._count = 1
        return StackResult(
            frame=self._current(frame),
            accepted=True,
            frames_stacked=1,
            rejection=previous_rejection,
        )

    def _refuse(self, frame: Frame, reason: str) -> StackResult:
        self._rejected += 1
        logger.debug("stack rejected a frame: %s", reason)
        return StackResult(
            frame=self._current(frame),
            accepted=False,
            frames_stacked=self._count,
            rejection=reason,
        )

    def _current(self, latest: Frame) -> Frame:
        """The stack as a Frame, carrying the metadata of the exposure just taken.

        `exposure_milliseconds` stays the single-frame exposure rather than the
        total. It describes how long each sub was, which is what the contract's
        `LiveFrameHeader.exposureMilliseconds` means beside a `stackedFrames`
        count; multiplying the two is the integration time, and inventing a
        long-exposure figure here would be the claim Phase 1 explicitly does not
        make.
        """
        assert self._accumulator is not None
        averaged = np.rint(self._accumulator / self._count).astype(np.uint16)

        return Frame(
            pixels=averaged,
            exposure_milliseconds=latest.exposure_milliseconds,
            gain=latest.gain,
            captured_at=latest.captured_at,
            mode=latest.mode,
            stacked_frames=self._count,
        )


def integration_seconds(exposure_milliseconds: float, frames_stacked: int) -> float:
    """Total time on target: how long each sub was, times how many were kept.

    Stated as a function rather than a field so there is one definition of it. It
    is what `Capture.integrationSeconds` means, and it counts the frames actually
    stacked -- not the frames requested, and not the wall-clock time, both of which
    would overstate what the image is made of.
    """
    return exposure_milliseconds * frames_stacked / 1000.0


