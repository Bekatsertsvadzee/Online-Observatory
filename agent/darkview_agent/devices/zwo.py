"""`ZwoCamera` -- the ASI585MC through the ZWO ASI SDK (DV-029, ADR-001).

The Python binding for the SDK is not chosen yet. ADR-001 names `zwoasi` as the
default candidate, to be confirmed against the physical camera on the observatory
mini-PC. So this class never touches a binding: it drives `AsiCamera`, a handful
of operations in this agent's own terms, and `zwoasi_binding.py` adapts `zwoasi`
to it. Choosing a different binding is a new adapter, not a change here.

Nothing here has run against a real camera. What is known only from the camera
is DV-035's: whether a frame arrives at all, how long readout takes after the
exposure ends, and what the 12-bit ADC's values look like in the 16-bit buffer.

**Frames are raw.** RAW16, one sample per photosite, binning 1, the full sensor.
The ASI585MC is a colour camera, so each frame is a Bayer mosaic, and the frame
says so: the pattern the camera reports travels on `Frame.bayer_pattern`, the
stack keeps the mosaic, and only the live view and the delivered image debayer
(ADR-021). Which pattern this sensor reports, and whether it comes out the right
way up, are first-light questions.

**`capturedAt` is when the exposure started**, taken from the wall clock as the
SDK is told to begin. That is the moment the sky in the frame belongs to; readout
finishing is not.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from typing import Protocol

import numpy as np

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.devices.base import (
    CameraDriver,
    CameraStatus,
    DeviceError,
    NotConnectedError,
)
from darkview_agent.devices.frame import Frame


class ExposureState(Enum):
    IDLE = "IDLE"
    WORKING = "WORKING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"


@dataclass(frozen=True)
class SensorInfo:
    name: str
    width_px: int
    height_px: int
    bit_depth: int
    is_color: bool
    #: The colour filter pattern, or None for a mono sensor (ADR-021).
    bayer_pattern: str | None
    gain_min: int
    gain_max: int
    exposure_min_us: int
    exposure_max_us: int


class AsiCamera(Protocol):
    """One camera, in this agent's terms. Every failure is raised as DeviceError."""

    def open(self) -> SensorInfo:
        """Open the camera for full-sensor RAW16 at binning 1 and describe it."""
        ...

    def close(self) -> None: ...

    def start_exposure(self, exposure_us: int, gain: int) -> None: ...

    def exposure_state(self) -> ExposureState: ...

    def read_data(self) -> bytes:
        """The finished exposure, little-endian 16-bit, row by row."""
        ...

    def stop_exposure(self) -> None: ...


class ZwoCamera(CameraDriver):
    def __init__(self, camera: AsiCamera) -> None:
        self._camera = camera
        self._info: SensorInfo | None = None
        self._exposure_milliseconds = 0.0
        self._gain = 0
        self._started_at: datetime | None = None
        self._complete = False

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.real

    def connect(self) -> None:
        if self._info is None:
            self._info = self._camera.open()

    def disconnect(self) -> None:
        if self._info is None:
            return
        try:
            self.abort_exposure()
            self._camera.close()
        finally:
            self._info = None

    def status(self) -> CameraStatus:
        info = self._info
        return CameraStatus(
            connected=info is not None,
            exposing=self._started_at is not None and not self._complete,
            width_px=info.width_px if info else 0,
            height_px=info.height_px if info else 0,
            health=DeviceHealth.ok if info else DeviceHealth.disconnected,
            mode=self.mode,
        )

    def expose(self, exposure_milliseconds: float, gain: int) -> None:
        info = self._require_connection()
        if exposure_milliseconds <= 0:
            raise ValueError("exposureMilliseconds must be greater than zero")
        exposure_us = round(exposure_milliseconds * 1000)
        if not info.exposure_min_us <= exposure_us <= info.exposure_max_us:
            raise ValueError(
                f"exposure {exposure_us} us is outside the camera's "
                f"{info.exposure_min_us}..{info.exposure_max_us} us"
            )
        if not info.gain_min <= gain <= info.gain_max:
            raise ValueError(
                f"gain {gain} is outside the camera's {info.gain_min}..{info.gain_max}"
            )

        # A new exposure replaces one still running, as it does on the simulator.
        if self._started_at is not None and not self._complete:
            self._camera.stop_exposure()
        self._started_at = None
        self._complete = False

        started_at = datetime.now(UTC)
        self._camera.start_exposure(exposure_us, gain)
        self._exposure_milliseconds = exposure_milliseconds
        self._gain = gain
        self._started_at = started_at

    def exposure_complete(self) -> bool:
        if self._started_at is None or self._info is None:
            return False
        if self._complete:
            return True

        state = self._camera.exposure_state()
        if state is ExposureState.SUCCESS:
            self._complete = True
            return True
        if state is ExposureState.WORKING:
            return False
        # FAILED, or IDLE with an exposure this driver started: the frame is gone.
        # Returning False would leave the mission waiting on it forever.
        self._started_at = None
        raise DeviceError(f"the camera reports the exposure {state.value}")

    def read_frame(self) -> Frame:
        if self._started_at is None:
            raise ValueError("no exposure has been started")
        if not self.exposure_complete():
            raise ValueError("exposure is still running")
        info = self._require_connection()

        data = self._camera.read_data()
        started_at = self._started_at
        self._started_at = None
        self._complete = False

        expected = info.width_px * info.height_px * 2
        if len(data) != expected:
            raise DeviceError(
                f"the camera returned {len(data)} bytes for a "
                f"{info.width_px}x{info.height_px} RAW16 frame; expected {expected}"
            )
        pixels = np.frombuffer(data, dtype="<u2").reshape(info.height_px, info.width_px)
        return Frame(
            pixels=pixels.astype(np.uint16),
            exposure_milliseconds=self._exposure_milliseconds,
            gain=self._gain,
            captured_at=started_at,
            mode=self.mode,
            bayer_pattern=info.bayer_pattern,
        )

    def abort_exposure(self) -> None:
        if self._started_at is not None and not self._complete and self._info is not None:
            self._camera.stop_exposure()
        self._started_at = None
        self._complete = False

    def _require_connection(self) -> SensorInfo:
        if self._info is None:
            raise NotConnectedError("camera is not connected")
        return self._info
