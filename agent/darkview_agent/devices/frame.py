"""One exposure and its metadata.

Deliberately imports nothing from the rest of the agent, so the device
interfaces can import it without a cycle.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from contracts.models import ObservatoryMode


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

    @property
    def height_px(self) -> int:
        return int(self.pixels.shape[0])

    @property
    def width_px(self) -> int:
        return int(self.pixels.shape[1])

    @property
    def is_simulated(self) -> bool:
        return self.mode is ObservatoryMode.simulated
