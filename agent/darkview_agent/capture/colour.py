"""Turning a Bayer mosaic into a picture (ADR-021, issue #113).

A one-shot colour sensor has a colour filter over every photosite in a repeating
2x2 pattern, so a raw frame carries one of red, green or blue per pixel and is not
an image until the two missing colours at each pixel are interpolated. ADR-021 puts
that step here, at the presentation boundary, and only here: the mosaic stays raw
through stacking, and the two places a person sees a frame -- the live view and the
delivered image -- call `to_display`.

**Bilinear.** Every missing sample is the mean of that colour's real samples in the
3x3 around it, which for a Bayer grid is exactly bilinear interpolation: four
diagonal neighbours for red or blue at the opposite site, two or four for green.
Known samples are never replaced by an interpolation of themselves. ADR-021 records
why no demosaicing library is taken for this, and what would justify one: colour
fringing on bright stars, judged on a real frame at first light.

**No white balance.** The channels are stretched together downstream, so a sky that
is brighter in green stays brighter in green. Balancing it is a decision about how
the real sensor and the real sky look, and neither exists yet.
"""

from __future__ import annotations

import numpy as np

from darkview_agent.devices.frame import Frame

#: Which colour sits at each position of the 2x2, row-major from the top-left.
BAYER_PATTERNS: dict[str, tuple[str, str, str, str]] = {
    "RGGB": ("R", "G", "G", "B"),
    "BGGR": ("B", "G", "G", "R"),
    "GRBG": ("G", "R", "B", "G"),
    "GBRG": ("G", "B", "R", "G"),
}

_CHANNEL_INDEX = {"R": 0, "G": 1, "B": 2}


def _masks(pattern: str, height: int, width: int) -> list[np.ndarray]:
    """One boolean mask per channel, marking where that colour was measured."""
    masks = [np.zeros((height, width), dtype=bool) for _ in range(3)]
    for position, colour in enumerate(BAYER_PATTERNS[pattern]):
        masks[_CHANNEL_INDEX[colour]][position // 2 :: 2, position % 2 :: 2] = True
    return masks


def _neighbourhood_sum(plane: np.ndarray) -> np.ndarray:
    """Sum of the 3x3 around each pixel, edges extended rather than zero-filled."""
    padded = np.pad(plane, 1, mode="edge")
    height, width = plane.shape
    total = np.zeros((height, width), dtype=np.float64)
    for dy in range(3):
        for dx in range(3):
            total += padded[dy : dy + height, dx : dx + width]
    return total


def debayer(pixels: np.ndarray, pattern: str) -> np.ndarray:
    """A mosaic as (height, width, 3) uint16."""
    if pattern not in BAYER_PATTERNS:
        raise ValueError(f"{pattern!r} is not a Bayer pattern")
    if pixels.ndim != 2:
        raise ValueError(f"expected a 2-D mosaic, got shape {pixels.shape}")

    values = pixels.astype(np.float64)
    height, width = pixels.shape
    rgb = np.zeros((height, width, 3), dtype=np.float64)

    for channel, mask in enumerate(_masks(pattern, height, width)):
        measured = np.where(mask, values, 0.0)
        # Dividing by the count of real samples in the window, not by nine, is
        # what makes this an interpolation rather than a blur -- and it is what
        # keeps the edges right, where a window has fewer neighbours.
        neighbours = _neighbourhood_sum(mask.astype(np.float64))
        interpolated = np.divide(
            _neighbourhood_sum(measured),
            neighbours,
            out=np.zeros_like(values),
            where=neighbours > 0,
        )
        rgb[:, :, channel] = np.where(mask, values, interpolated)

    return np.clip(np.rint(rgb), 0, 65535).astype(np.uint16)


def to_display(frame: Frame) -> np.ndarray:
    """What a person should be shown: RGB for a mosaic, the frame itself otherwise.

    A mono frame -- every simulated one, and a mono camera if one is ever
    fitted -- passes through untouched, so nothing about the simulator changes.
    """
    if frame.bayer_pattern is None:
        return frame.pixels
    return debayer(frame.pixels, frame.bayer_pattern)
