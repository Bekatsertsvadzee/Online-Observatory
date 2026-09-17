"""`AsiCamera` over the `zwoasi` binding -- the default candidate, not yet pinned.

Written against zwoasi's published interface (python-zwoasi, `zwoasi/__init__.py`)
and the ZWO ASI SDK it wraps, and run against neither. `zwoasi` is imported when a
camera is opened, not when this module is, so nothing in the agent needs the
binding or the SDK library until real hardware is selected. It is not a
dependency in `pyproject.toml` until DV-035 confirms it on the camera.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.zwo import ExposureState, SensorInfo

#: zwoasi's ASI_BAYER_* values, in order. The two-letter name is the top row of
#: the 2x2; the bottom row is the other two colours, which is why RG means RGGB.
_BAYER_PATTERNS = ("RGGB", "BGGR", "GRBG", "GBRG")

#: zwoasi's ASI_EXP_* values, in order.
_EXPOSURE_STATES = (
    ExposureState.IDLE,
    ExposureState.WORKING,
    ExposureState.SUCCESS,
    ExposureState.FAILED,
)


class ZwoasiCamera:
    """The one camera whose name contains `name`."""

    def __init__(self, library_path: str, name: str = "ASI585MC") -> None:
        self._library_path = library_path
        self._name = name
        self._asi: Any = None
        self._camera: Any = None

    def open(self) -> SensorInfo:
        try:
            import zwoasi
        except ImportError as error:
            raise DeviceError(f"the zwoasi binding is not installed: {error}") from None
        self._asi = zwoasi

        with self._translated("open"):
            # init raises if called twice in one process; a reconnect is not an error.
            if not getattr(zwoasi, "zwolib", None):
                zwoasi.init(self._library_path)
            matches = [
                index for index, name in enumerate(zwoasi.list_cameras()) if self._name in name
            ]
            if len(matches) != 1:
                raise DeviceError(
                    f"expected exactly one camera named {self._name}, found {len(matches)}"
                )
            camera = zwoasi.Camera(matches[0])
            properties = camera.get_camera_property()
            controls = camera.get_controls()
            camera.set_roi(bins=1, image_type=zwoasi.ASI_IMG_RAW16)
            self._camera = camera

        return SensorInfo(
            name=str(properties["Name"]),
            width_px=int(properties["MaxWidth"]),
            height_px=int(properties["MaxHeight"]),
            bit_depth=int(properties["BitDepth"]),
            is_color=bool(properties["IsColorCam"]),
            bayer_pattern=(
                _BAYER_PATTERNS[int(properties["BayerPattern"])]
                if properties["IsColorCam"]
                else None
            ),
            gain_min=int(controls["Gain"]["MinValue"]),
            gain_max=int(controls["Gain"]["MaxValue"]),
            exposure_min_us=int(controls["Exposure"]["MinValue"]),
            exposure_max_us=int(controls["Exposure"]["MaxValue"]),
        )

    def close(self) -> None:
        with self._translated("close"):
            if self._camera is not None:
                self._camera.close()
        self._camera = None

    def start_exposure(self, exposure_us: int, gain: int) -> None:
        with self._translated("start_exposure"):
            self._camera.set_control_value(self._asi.ASI_EXPOSURE, exposure_us)
            self._camera.set_control_value(self._asi.ASI_GAIN, gain)
            self._camera.start_exposure()

    def exposure_state(self) -> ExposureState:
        with self._translated("exposure_state"):
            return _EXPOSURE_STATES[self._camera.get_exposure_status()]

    def read_data(self) -> bytes:
        with self._translated("read_data"):
            return bytes(self._camera.get_data_after_exposure())

    def stop_exposure(self) -> None:
        with self._translated("stop_exposure"):
            self._camera.stop_exposure()

    @contextmanager
    def _translated(self, operation: str) -> Iterator[None]:
        """Every binding or SDK error leaves as DeviceError, which the agent handles."""
        try:
            yield
        except DeviceError:
            raise
        except Exception as error:
            raise DeviceError(f"ZWO camera {operation} failed: {error}") from error
