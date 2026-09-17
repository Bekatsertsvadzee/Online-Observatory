"""An `AsiCamera` that exposes on a `ManualClock`.

It keeps the SDK behaviour `ZwoCamera` has to handle -- an exposure that is
WORKING until its time has passed, a frame that can only be read after SUCCESS,
an exposure that can FAIL -- and nothing about the real ASI585MC, which nothing
here has seen.
"""

from __future__ import annotations

import numpy as np

from darkview_agent.clock import ManualClock
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.zwo import ExposureState, SensorInfo, ZwoCamera


class FakeAsiCamera:
    def __init__(self, clock: ManualClock, width_px: int = 64, height_px: int = 48) -> None:
        self.clock = clock
        self.info = SensorInfo(
            name="ZWO ASI585MC",
            width_px=width_px,
            height_px=height_px,
            bit_depth=12,
            is_color=True,
            gain_min=0,
            gain_max=570,
            exposure_min_us=32,
            exposure_max_us=2_000_000_000,
        )
        self.open_count = 0
        self.closed = False
        self.started: list[tuple[int, int]] = []
        self.stopped = 0
        self.fail_next = False
        self.short_read = False
        self._deadline: float | None = None
        self._failed = False

    def open(self) -> SensorInfo:
        self.open_count += 1
        self.closed = False
        return self.info

    def close(self) -> None:
        self.closed = True

    def start_exposure(self, exposure_us: int, gain: int) -> None:
        self.started.append((exposure_us, gain))
        self._deadline = self.clock.monotonic() + exposure_us / 1_000_000
        self._failed, self.fail_next = self.fail_next, False

    def exposure_state(self) -> ExposureState:
        if self._deadline is None:
            return ExposureState.IDLE
        if self.clock.monotonic() < self._deadline:
            return ExposureState.WORKING
        return ExposureState.FAILED if self._failed else ExposureState.SUCCESS

    def read_data(self) -> bytes:
        if self.exposure_state() is not ExposureState.SUCCESS:
            raise DeviceError("no completed exposure")
        self._deadline = None
        pixels = np.arange(self.info.width_px * self.info.height_px, dtype="<u2")
        data = pixels.tobytes()
        return data[:-2] if self.short_read else data

    def stop_exposure(self) -> None:
        self.stopped += 1
        self._deadline = None


def zwo_camera(clock: ManualClock) -> ZwoCamera:
    return ZwoCamera(FakeAsiCamera(clock))
