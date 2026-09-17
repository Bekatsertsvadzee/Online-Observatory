"""Autofocus, and every focuser move that has to land where it says (DV-031).

**Every move ends travelling outward.** A focuser has backlash: after a reversal
the motor turns through the slack before the optics move, so the same motor
position puts the optics in two different places depending on the direction it
was reached from. A move that must end inward first goes past the target by
`backlash_overshoot` steps and then comes back out. Every sample of a focus curve
and the final position are reached the same way, so they all carry the same
offset and it cancels. The overshoot must exceed the real backlash; the default
is a placeholder until it is measured on the motor.

**Focus is judged by star size.** The half-flux radius of the stars in a frame is
smallest in focus and grows either side of it. The routine takes frames at evenly
spaced positions around where the focuser is now, fits the curve, and moves to
its minimum. Star size either side of focus is a hyperbola -- the blur adds to
the seeing in quadrature, so it is flat at the bottom and straight up the sides
-- and a parabola fitted to it is pulled toward whichever side has more samples.
The square of the size is a parabola, so that is what is fitted. A curve with no
minimum inside the sampled range is a failure, not an extrapolation: the focuser
goes back where it started.

**Polled, like the mission runner.** `pump()` does whatever is due and returns.
Nothing sleeps and nothing waits on a device, so the supervisor's pass and the
link's heartbeat carry on while the focuser travels and the camera exposes.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from darkview_agent.capture.stack import background_and_noise
from darkview_agent.devices.base import CameraDriver, FocuserDriver
from darkview_agent.devices.frame import Frame

logger = logging.getLogger("darkview.agent.focus")

#: PLACEHOLDER until the backlash is measured on the real focus motor.
DEFAULT_BACKLASH_OVERSHOOT_STEPS = 100
DEFAULT_STEP_SIZE = 200
DEFAULT_SAMPLES = 7

#: Fewer measured samples than this and the curve is fitted to noise.
MIN_MEASURED_SAMPLES = 5
#: Fewer stars than this and a frame's star size is one star's opinion.
MIN_STARS = 3
STAR_BOX_RADIUS_PX = 15
MAX_STARS = 40
DETECTION_SIGMA = 5.0


def approach(current: int, target: int, overshoot: int) -> list[int]:
    """The moves that reach `target` travelling outward."""
    if target >= current:
        return [target]
    return [max(0, target - overshoot), target]


def half_flux_radius(pixels: np.ndarray) -> float | None:
    """Median flux-weighted radius of the brightest isolated stars, in pixels.

    None when fewer than `MIN_STARS` stand clear of the sky: a cloudy frame or
    one so far out of focus that the stars have spread into the background.
    """
    data = pixels.astype(np.float64)
    background, noise = background_and_noise(pixels)
    noise = max(noise, 1.0)
    height, width = data.shape
    box = STAR_BOX_RADIUS_PX

    windows = np.lib.stride_tricks.sliding_window_view(np.pad(data, 1, mode="edge"), (3, 3))
    peaks = (data >= windows.max(axis=(2, 3))) & (data > background + DETECTION_SIGMA * noise)
    peaks[:box, :] = peaks[-box:, :] = False
    peaks[:, :box] = peaks[:, -box:] = False

    ys, xs = np.nonzero(peaks)
    order = np.argsort(data[ys, xs])[::-1]
    offsets = np.mgrid[-box : box + 1, -box : box + 1]

    taken: list[tuple[int, int]] = []
    radii: list[float] = []
    for index in order:
        y, x = int(ys[index]), int(xs[index])
        # A neighbour's light inside the box would make both stars look bigger.
        if any(abs(y - ty) <= 2 * box and abs(x - tx) <= 2 * box for ty, tx in taken):
            continue
        taken.append((y, x))

        flux = data[y - box : y + box + 1, x - box : x + box + 1] - background
        flux[flux < noise] = 0.0
        total = flux.sum()
        if total <= 0:
            continue
        centre_y = (flux * offsets[0]).sum() / total
        centre_x = (flux * offsets[1]).sum() / total
        distance = np.hypot(offsets[0] - centre_y, offsets[1] - centre_x)
        radii.append(float((flux * distance).sum() / total))
        if len(radii) == MAX_STARS:
            break

    if len(radii) < MIN_STARS:
        return None
    return float(np.median(radii))


class FocusMove:
    """Reach one position, travelling outward at the end."""

    def __init__(
        self,
        focuser: FocuserDriver,
        target: int,
        overshoot: int = DEFAULT_BACKLASH_OVERSHOOT_STEPS,
    ) -> None:
        status = focuser.status()
        if not 0 <= target <= status.max_position:
            raise ValueError(f"focus position must be within 0..{status.max_position}")
        self._focuser = focuser
        self._legs = approach(status.position, target, overshoot)

    def pump(self) -> bool:
        """True once the last leg has finished."""
        if self._focuser.status().moving:
            return False
        if not self._legs:
            return True
        self._focuser.move_to(self._legs.pop(0))
        return False


@dataclass(frozen=True)
class FocusResult:
    succeeded: bool
    position: int
    detail: str
    #: (focuser position, half-flux radius or None) for every frame taken.
    samples: tuple[tuple[int, float | None], ...] = ()


class Autofocus:
    def __init__(
        self,
        focuser: FocuserDriver,
        camera: CameraDriver,
        *,
        exposure_milliseconds: float,
        gain: int,
        step_size: int = DEFAULT_STEP_SIZE,
        samples: int = DEFAULT_SAMPLES,
        overshoot: int = DEFAULT_BACKLASH_OVERSHOOT_STEPS,
        show: Callable[[Frame], None] | None = None,
    ) -> None:
        if samples < MIN_MEASURED_SAMPLES:
            raise ValueError(f"autofocus needs at least {MIN_MEASURED_SAMPLES} samples")
        self._focuser = focuser
        self._camera = camera
        self._exposure = exposure_milliseconds
        self._gain = gain
        self._overshoot = overshoot
        self._show = show or (lambda frame: None)

        status = focuser.status()
        self._start = status.position
        span = step_size * (samples - 1)
        # The window keeps its width and slides to fit the travel, leaving room
        # below it for the overshoot of the first approach.
        lowest = min(max(status.position - span // 2, overshoot), status.max_position - span)
        if lowest < overshoot:
            raise ValueError("the sampling span does not fit the focuser's travel")
        self._positions = [lowest + step_size * i for i in range(samples)]

        self._measured: list[tuple[int, float | None]] = []
        self._move: FocusMove | None = FocusMove(focuser, self._positions[0], overshoot)
        self._exposing = False
        self._finish: tuple[bool, int, str] | None = None
        self.result: FocusResult | None = None

    def pump(self) -> FocusResult | None:
        if self.result is not None:
            return self.result

        if self._move is not None:
            if not self._move.pump():
                return None
            self._move = None
            if self._finish is not None:
                succeeded, position, detail = self._finish
                self.result = FocusResult(succeeded, position, detail, tuple(self._measured))
                logger.info("autofocus %s: %s", "done" if succeeded else "failed", detail)
                return self.result

        if not self._exposing:
            self._camera.expose(self._exposure, self._gain)
            self._exposing = True
            return None
        if not self._camera.exposure_complete():
            return None

        frame = self._camera.read_frame()
        self._show(frame)
        self._exposing = False
        position = self._positions[len(self._measured)]
        self._measured.append((position, half_flux_radius(frame.pixels)))

        if len(self._measured) < len(self._positions):
            self._move = FocusMove(self._focuser, self._positions[len(self._measured)])
            return None

        self._conclude()
        return None

    def cancel(self) -> None:
        """Stop the motor and the exposure. The focuser stays wherever it stopped."""
        self._focuser.halt()
        self._camera.abort_exposure()
        if self.result is None:
            self.result = FocusResult(
                False, self._focuser.status().position, "cancelled", tuple(self._measured)
            )

    def _conclude(self) -> None:
        measured = [(p, r) for p, r in self._measured if r is not None]
        best, detail = None, ""
        if len(measured) < MIN_MEASURED_SAMPLES:
            detail = f"only {len(measured)} of {len(self._measured)} frames had enough stars"
        else:
            positions = np.array([p for p, _ in measured], dtype=np.float64)
            radii = np.array([r for _, r in measured])
            # Centred and scaled, or the squared term of a position near 16000
            # swamps the fit's conditioning.
            centre, scale = positions.mean(), max(np.ptp(positions), 1.0)
            a, b, _ = np.polyfit((positions - centre) / scale, radii**2, 2)
            vertex = centre - b / (2 * a) * scale if a > 0 else None
            if vertex is None:
                detail = "star size has no minimum across the sampled positions"
            elif not positions.min() <= vertex <= positions.max():
                detail = f"best focus near {vertex:.0f} is outside the sampled range"
            else:
                best = int(round(vertex))
                detail = f"best focus at {best}"

        if best is None:
            self._finish = (False, self._start, f"{detail}; returned to {self._start}")
            self._move = FocusMove(self._focuser, self._start, self._overshoot)
        else:
            self._finish = (True, best, detail)
            self._move = FocusMove(self._focuser, best, self._overshoot)
