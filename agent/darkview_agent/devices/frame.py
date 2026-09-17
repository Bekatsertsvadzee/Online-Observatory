"""One exposure and its metadata.

Deliberately imports nothing from the rest of the agent, so the device
interfaces can import it without a cycle.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from contracts.models import ObservatoryMode

#: Spelled out here rather than imported: `frame` deliberately imports nothing
#: from the rest of the agent, and `capture.colour` imports this module.
_BAYER_PATTERNS = ("RGGB", "BGGR", "GRBG", "GBRG")


@dataclass(frozen=True)
class Frame:
    """A single exposure.

    `pixels` is 16-bit unsigned, shape (height, width). Encoding to JPEG or PNG
    for the live view is DV-032's job; this is the raw sensor-shaped data.

    `mode` is carried on the frame itself rather than added by whatever transmits
    it. A frame that travels without its provenance is a frame that can be
    presented as real telescope output by mistake.
    """

    pixels: np.ndarray
    exposure_milliseconds: float
    gain: int
    captured_at: datetime
    mode: ObservatoryMode
    stacked_frames: int | None = None
    bayer_pattern: str | None = None
    """The sensor's colour filter pattern, or None for a genuinely mono frame.

    Carried with the data rather than looked up from configuration, for the same
    reason `mode` is: a frame that travelled without it could be rendered as a
    grey checkerboard, or worse, stacked with its colours swapped (ADR-021).
    """

    def __post_init__(self) -> None:
        if self.pixels.ndim != 2:
            raise ValueError(f"expected a 2-D frame, got shape {self.pixels.shape}")
        if self.pixels.dtype != np.uint16:
            raise ValueError(f"expected uint16 pixels, got {self.pixels.dtype}")
        if self.exposure_milliseconds <= 0:
            raise ValueError("exposureMilliseconds must be greater than zero")
        if self.gain < 0:
            raise ValueError("gain must not be negative")
        if self.captured_at.tzinfo is None:
            raise ValueError("capturedAt must be timezone-aware")
        if self.bayer_pattern is not None and self.bayer_pattern not in _BAYER_PATTERNS:
            raise ValueError(
                f"{self.bayer_pattern!r} is not a Bayer pattern; "
                f"expected one of {', '.join(sorted(_BAYER_PATTERNS))} or None"
            )

    @property
    def height_px(self) -> int:
        return int(self.pixels.shape[0])

    @property
    def width_px(self) -> int:
        return int(self.pixels.shape[1])

    @property
    def is_mosaic(self) -> bool:
        """Whether this frame is raw colour-filtered data rather than an image."""
        return self.bayer_pattern is not None

    @property
    def is_simulated(self) -> bool:
        return self.mode is ObservatoryMode.simulated
