"""What a frame shows, and the exposure that would show it well (ADR-080 §1).

Ported from the maintainer's own panel (`~/telescope/panel.py`: `stats`,
`classify`, `run_autoexpose` and its `AE` table; the star finder is
`imaging.analyze`). The panel already gets a good picture out of this telescope by
recognising the scene from the frame's statistics and walking exposure and gain
towards one statistic per scene. The logic is kept as it is there; what changes is
the shape:

- **Polled, not blocking.** The panel's loop sets the camera, waits for a frame
  and adjusts. The mission runner owns the camera and is pumped, so
  `AutoExposure` is told each frame's statistics and answers with the next
  settings, the way `Autofocus` is.
- **Milliseconds**, the agent's unit, not the panel's microseconds.
- **Bounded by the imaging profile.** Where the panel's table reaches further
  (deep sky to 15 s) the profile's range wins (`profiles.EXPOSURE_RANGES`).
- No bit-depth switching: the agent's frames are always 16-bit.

PROVISIONAL: every figure is the panel's, tuned by eye on this telescope, and the
simulator defines none of them. DV-035 measures them on the ASI585MC. Nothing here
moves a telescope.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from contracts.models import ImagingProfile
from darkview_agent.capture.profiles import EXPOSURE_RANGES
from darkview_agent.devices.frame import Frame

FULL_SCALE = 65535.0

#: Most tries one auto-exposure run makes (the panel's `range(14)`).
MAX_AUTO_EXPOSE_TRIES = 14


@dataclass(frozen=True)
class SceneSettings:
    """One row of the panel's `AE` table, in milliseconds."""

    statistic: str
    goal: float
    start_gain: int
    min_exposure_milliseconds: float
    max_exposure_milliseconds: float
    max_gain: int
    label: str


#: The panel's table, microseconds turned into milliseconds; the bit-depth column
#: is dropped.
AE: dict[str, SceneSettings] = {
    "daylight": SceneSettings("median", 0.42, 0, 0.032, 200.0, 100, "Daylight scene"),
    "bright": SceneSettings("peak", 0.75, 100, 0.032, 100.0, 300, "Bright light"),
    "moon": SceneSettings("peak", 0.80, 50, 0.032, 50.0, 200, "Moon"),
    "planet": SceneSettings("peak", 0.72, 250, 0.05, 100.0, 450, "Planet"),
    "star": SceneSettings("top", 0.60, 150, 0.05, 300.0, 400, "Bright star"),
    "cluster": SceneSettings("bg", 0.07, 250, 100.0, 5000.0, 400, "Star cluster / star field"),
    "deepsky": SceneSettings("bg", 0.12, 300, 500.0, 15000.0, 400, "Nebula / galaxy"),
}

#: The starting scene each imaging profile names (ADR-080 §1).
SCENE_FOR_PROFILE: dict[ImagingProfile, str] = {
    ImagingProfile.lunar: "moon",
    ImagingProfile.planetary: "planet",
    ImagingProfile.double_star: "star",
    ImagingProfile.globular_cluster: "cluster",
    ImagingProfile.planetary_nebula: "deepsky",
    ImagingProfile.bright_nebula: "deepsky",
}

#: Profiles centred on the bright disc's centroid instead of a plate solve.
DISC_PROFILES = frozenset({ImagingProfile.lunar, ImagingProfile.planetary})


def is_disc(profile: ImagingProfile | None) -> bool:
    return profile in DISC_PROFILES


@dataclass(frozen=True)
class FrameStats:
    """The panel's `stats()`: all fractions of full scale except `stars`."""

    peak: float
    median: float
    bg: float
    clip: float
    blob: float
    stars: int
    top: float

    def value(self, statistic: str) -> float:
        return float(getattr(self, statistic))


def _lum(raw: np.ndarray) -> np.ndarray:
    height, width = raw.shape[0] // 2 * 2, raw.shape[1] // 2 * 2
    a = raw[:height, :width].astype(np.float32)
    return (a[0::2, 0::2] + a[0::2, 1::2] + a[1::2, 0::2] + a[1::2, 1::2]) * 0.25


def _maxfilt(a: np.ndarray, radius: int) -> np.ndarray:
    m = a.copy()
    for d in range(1, radius + 1):
        m[:, d:] = np.maximum(m[:, d:], a[:, :-d])
        m[:, :-d] = np.maximum(m[:, :-d], a[:, d:])
    n = m.copy()
    for d in range(1, radius + 1):
        n[d:] = np.maximum(n[d:], m[:-d])
        n[:-d] = np.maximum(n[:-d], m[d:])
    return n


def find_stars(raw: np.ndarray, full_scale: float = FULL_SCALE) -> tuple[list, float]:
    """`imaging.analyze`'s star list and peak: [(x, y)] in sensor pixels.

    The panel ignores a 12-pixel border of the binned frame. Scaled down for the
    small frames the simulator's unit tests use, or a 64-pixel frame has no inside.
    """
    lum = _lum(raw)
    sub = lum[::4, ::4]
    median = float(np.median(sub))
    sigma = 1.4826 * float(np.median(np.abs(sub - median))) + 1e-3
    peaks = (lum == _maxfilt(lum, 3)) & (lum > median + 8 * sigma)
    border = max(1, min(12, lum.shape[0] // 8, lum.shape[1] // 8))
    peaks[:border], peaks[-border:], peaks[:, :border], peaks[:, -border:] = (
        False,
        False,
        False,
        False,
    )
    ys, xs = np.nonzero(peaks)
    order = np.argsort(lum[ys, xs])[::-1][:300]
    r = 9
    yy, xx = np.mgrid[-r : r + 1, -r : r + 1]
    dist = np.hypot(yy, xx)
    disk = dist <= r
    stars = []
    for y, x in zip(ys[order], xs[order], strict=True):
        if lum[y, x] >= full_scale * 0.95:
            continue
        if y < r or x < r or y + r + 1 > lum.shape[0] or x + r + 1 > lum.shape[1]:
            continue
        p = lum[y - r : y + r + 1, x - r : x + r + 1] - median
        p = np.where(p > 2.5 * sigma, p, 0) * disk
        flux = p.sum()
        if flux <= 0:
            continue
        hfr = float((p * dist).sum() / flux)
        if hfr < 0.5 or hfr > r * 0.7:
            continue
        cy, cx = float((p * yy).sum() / flux), float((p * xx).sum() / flux)
        stars.append((float(x + cx) * 2 + 1, float(y + cy) * 2 + 1))
        if len(stars) >= 80:
            break
    return stars, float(lum.max())


#: Radius, in 2x-binned pixels, of the opening that takes star cores out of the
#: bright mask. One deliberate change from the panel: there, the mask is everything
#: above half the frame's peak, which on a dense field is every bright star's core,
#: so a star field reads as a disc ("bright") and its stars are not counted. A
#: Moon or planet is far wider than seven binned pixels; a star core is not.
BLOB_OPENING_RADIUS = 3


def _bright_mask(binned: np.ndarray) -> tuple[np.ndarray, float, float]:
    """The panel's bright-blob mask, opened, plus the median and peak it used."""
    median = float(np.median(binned))
    peak = float(np.percentile(binned, 99.97))
    if peak - median <= 0.15:
        return np.zeros(binned.shape, bool), median, peak
    mask = binned > median + 0.5 * (peak - median)
    r = BLOB_OPENING_RADIUS
    eroded = _maxfilt((~mask).astype(np.float32), r) == 0
    if not eroded.any():
        return np.zeros(binned.shape, bool), median, peak
    return _maxfilt(eroded.astype(np.float32), r) > 0, median, peak


def stats(frame: Frame, full_scale: float = FULL_SCALE) -> FrameStats:
    """The panel's `stats()`: 2x downsampled, normalised to full scale."""
    a = frame.pixels[::2, ::2].astype(np.float32) / full_scale
    mask, median, peak = _bright_mask(a)
    found, top = find_stars(frame.pixels, full_scale)
    height, width = mask.shape
    stars = sum(
        1
        for x, y in found
        if not mask[min(height - 1, int(y) // 2), min(width - 1, int(x) // 2)]
    )
    return FrameStats(
        peak=peak,
        median=median,
        bg=float(np.percentile(a, 25)),
        clip=float((a >= 0.98).mean()),
        blob=float(mask.mean()),
        stars=stars,
        top=top / full_scale,
    )


def classify(m: FrameStats, hint: str | None) -> str | None:
    """The panel's `classify()`. None means too bright to tell yet."""
    if m.median > 0.2 or (m.clip > 0.25 and m.bg > 0.1):
        return "daylight"
    if m.clip > 0.02 and m.blob > 0.02:
        return None
    if m.blob > 0.03:
        return "moon" if hint in (None, "moon") else "bright"
    if m.blob > 0.0004 and m.stars < 6:
        return hint if hint in ("planet", "moon") else "bright"
    if m.stars >= 6:
        return "deepsky" if hint == "deepsky" else "cluster"
    if m.stars >= 1 and m.top > 0.3 and hint in (None, "star", "planet"):
        return "star"
    return "deepsky" if hint == "deepsky" else "cluster"


def drifted(m: FrameStats, scene: str | None, hint: str | None) -> bool:
    """The panel's `ae_loop` test: has the picture left its scene's goal?"""
    if scene not in AE:
        return True
    settings = AE[scene]
    v = m.value(settings.statistic)
    return (
        classify(m, hint) not in (scene, None)
        or not (settings.goal * 0.6 < v < settings.goal * 1.6)
        or (m.clip > 0.05 and settings.statistic == "peak")
    )


@dataclass(frozen=True)
class Disc:
    """The bright disc: centroid offset from the frame centre, in pixels."""

    dx_px: float
    dy_px: float
    blob: float
    peak: float


#: A disc smaller than this fraction of the frame is not one (the panel's planet
#: threshold in `classify`).
MIN_DISC_FRACTION = 0.0004


def disc_centroid(frame: Frame, full_scale: float = FULL_SCALE) -> Disc | None:
    """Where the Moon or planet is, from the same bright mask `stats` uses.

    No plate solve: a disc at these exposures has no field stars (ADR-080 §5).
    """
    a = frame.pixels[::2, ::2].astype(np.float32) / full_scale
    mask, _median, peak = _bright_mask(a)
    fraction = float(mask.mean())
    if fraction < MIN_DISC_FRACTION:
        return None
    ys, xs = np.nonzero(mask)
    return Disc(
        dx_px=float(xs.mean()) * 2 + 0.5 - (frame.width_px - 1) / 2.0,
        dy_px=float(ys.mean()) * 2 + 0.5 - (frame.height_px - 1) / 2.0,
        blob=fraction,
        peak=peak,
    )


class AutoExposure:
    """`run_autoexpose('auto', target)`, one frame at a time.

    `settings` is what to expose next; `feed` takes that frame's statistics and
    returns True once the run has finished. At most 14 frames.
    """

    def __init__(
        self, profile: ImagingProfile, exposure_milliseconds: float, gain: int
    ) -> None:
        self._profile = profile
        self.hint = SCENE_FOR_PROFILE[profile]
        self._range = EXPOSURE_RANGES[profile]
        self.scene: str | None = None
        self._switches = 0
        self.tries = 0
        self.exposure_milliseconds = self._clamp(exposure_milliseconds, *self._range)
        self.gain = gain
        self.finished = False

    @property
    def settings(self) -> tuple[float, int]:
        return self.exposure_milliseconds, int(self.gain)

    def _bounds(self, scene: str) -> tuple[float, float]:
        """The scene's exposure range inside the profile's (ADR-080 §1)."""
        low_p, high_p = self._range
        settings = AE[scene]
        low = max(settings.min_exposure_milliseconds, low_p)
        high = min(settings.max_exposure_milliseconds, high_p)
        return (low, high) if low <= high else (low_p, high_p)

    @staticmethod
    def _clamp(value: float, low: float, high: float) -> float:
        return min(high, max(low, value))

    def feed(self, m: FrameStats) -> bool:
        if self.finished:
            return True
        self.tries += 1
        self.finished = self._step(m) or self.tries >= MAX_AUTO_EXPOSE_TRIES
        return self.finished

    def _step(self, m: FrameStats) -> bool:
        exp, gain = self.exposure_milliseconds, self.gain
        new = classify(m, self.hint)
        if new is None:
            # Blown out: cut hard and look again.
            if exp > 0.064:
                exp = max(0.032, exp / 6)
            if exp <= 0.064:
                gain = max(0, gain - 150)
            self.exposure_milliseconds = self._clamp(exp, *self._range)
            self.gain = gain
            return False
        if new != self.scene and self._switches < 3:
            self.scene, self._switches = new, self._switches + 1
            self.gain = AE[new].start_gain
            self.exposure_milliseconds = self._clamp(exp, *self._bounds(new))
            return False

        assert self.scene is not None
        settings = AE[self.scene]
        low, high = self._bounds(self.scene)
        v = max(m.value(settings.statistic), 1e-4)
        goal = settings.goal
        if (abs(v - goal) / goal < 0.15 and m.peak < 0.99) or (
            settings.statistic != "peak" and m.peak >= 0.99 and v > goal * 0.5
        ):
            return True
        want = exp * goal / v if v < 0.98 else exp / 4
        if want > high and gain < settings.max_gain:
            gain = min(settings.max_gain, gain + 100)
            want = exp
        elif want < low and gain > 0:
            gain = max(0, gain - 100)
            want = exp
        new_exp = self._clamp(want, low, high)
        self.gain = gain
        if new_exp == exp and (want > high or want < low):
            return True  # at the limit
        self.exposure_milliseconds = new_exp
        return False


__all__ = [
    "AE",
    "DISC_PROFILES",
    "MAX_AUTO_EXPOSE_TRIES",
    "SCENE_FOR_PROFILE",
    "AutoExposure",
    "Disc",
    "FrameStats",
    "classify",
    "disc_centroid",
    "drifted",
    "find_stars",
    "is_disc",
    "stats",
]
