"""DV-029: `ZwoCamera` and the `zwoasi` adapter, without a camera.

The conformance suite proves `ZwoCamera` keeps the `CameraDriver` interface.
These prove what only a real-camera driver owns -- the camera's own limits, units,
timestamps, a failed exposure, a short read -- and that the adapter calls the
binding the way its published interface says. None of it proves the camera
delivers a frame; that is DV-035.
"""

from __future__ import annotations

import subprocess
import sys
import types
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.devices.base import DeviceError, NotConnectedError
from darkview_agent.devices.zwo import ExposureState, ZwoCamera
from darkview_agent.devices.zwoasi_binding import ZwoasiCamera
from tests.fake_asi import FakeAsiCamera


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock()


@pytest.fixture
def sdk(clock) -> FakeAsiCamera:
    return FakeAsiCamera(clock)


@pytest.fixture
def camera(sdk) -> ZwoCamera:
    camera = ZwoCamera(sdk)
    camera.connect()
    return camera


# --------------------------------------------------------------------------
# ZwoCamera
# --------------------------------------------------------------------------


def test_connecting_twice_opens_the_camera_once(sdk, camera):
    camera.connect()
    assert sdk.open_count == 1


def test_the_status_reports_the_sensor_the_camera_described(camera):
    status = camera.status()
    assert (status.width_px, status.height_px) == (64, 48)


def test_milliseconds_reach_the_sdk_as_microseconds(sdk, camera):
    camera.expose(1500.5, 250)
    assert sdk.started == [(1_500_500, 250)]


@pytest.mark.parametrize("gain", [-1, 571])
def test_a_gain_outside_the_camera_s_range_is_refused(sdk, camera, gain):
    with pytest.raises(ValueError, match="gain"):
        camera.expose(1000.0, gain)
    assert sdk.started == []


def test_an_exposure_shorter_than_the_camera_allows_is_refused(sdk, camera):
    with pytest.raises(ValueError, match="exposure"):
        camera.expose(0.01, 100)
    assert sdk.started == []


def test_captured_at_is_when_the_exposure_started(clock, camera):
    before = datetime.now(UTC)
    camera.expose(2000.0, 100)
    after = datetime.now(UTC)
    clock.advance(2.0)

    frame = camera.read_frame()

    assert before <= frame.captured_at <= after


def test_pixels_are_read_little_endian_row_by_row(clock, camera):
    camera.expose(10.0, 0)
    clock.advance(1.0)

    frame = camera.read_frame()

    expected = np.arange(64 * 48, dtype=np.uint16).reshape(48, 64)
    np.testing.assert_array_equal(frame.pixels, expected)


def test_a_failed_exposure_is_a_device_error_not_a_wait(clock, sdk, camera):
    """Returning False forever would leave a mission waiting on a frame that is gone."""
    sdk.fail_next = True
    camera.expose(1000.0, 100)
    clock.advance(2.0)

    with pytest.raises(DeviceError, match="FAILED"):
        camera.exposure_complete()
    assert camera.status().exposing is False


def test_an_exposure_the_camera_forgot_is_a_device_error(clock, sdk, camera):
    camera.expose(1000.0, 100)
    sdk.stop_exposure()  # the camera went idle without this driver asking

    with pytest.raises(DeviceError, match="IDLE"):
        camera.exposure_complete()


def test_a_short_read_is_a_device_error(clock, sdk, camera):
    sdk.short_read = True
    camera.expose(10.0, 0)
    clock.advance(1.0)

    with pytest.raises(DeviceError, match="bytes"):
        camera.read_frame()


def test_a_new_exposure_stops_the_one_still_running(sdk, camera):
    camera.expose(5000.0, 100)
    camera.expose(1000.0, 100)
    assert sdk.stopped == 1


def test_abort_stops_a_running_exposure_and_nothing_else(clock, sdk, camera):
    camera.abort_exposure()
    assert sdk.stopped == 0

    camera.expose(5000.0, 100)
    camera.abort_exposure()
    assert sdk.stopped == 1
    assert camera.status().exposing is False


def test_disconnect_closes_the_camera(sdk, camera):
    camera.disconnect()
    assert sdk.closed is True
    with pytest.raises(NotConnectedError):
        camera.expose(1000.0, 100)


def test_the_frame_is_labelled_real(clock, camera):
    camera.expose(10.0, 0)
    clock.advance(1.0)
    assert camera.read_frame().mode.value == "REAL"


# --------------------------------------------------------------------------
# The zwoasi adapter
# --------------------------------------------------------------------------


class _FakeZwoasiCamera:
    def __init__(self, module, index):
        self.module = module
        self.index = index
        self.calls: list[tuple] = []
        module.opened.append(self)

    def get_camera_property(self):
        return {
            "Name": "ZWO ASI585MC",
            "MaxWidth": 3840,
            "MaxHeight": 2160,
            "BitDepth": 12,
            "IsColorCam": True,
        }

    def get_controls(self):
        return {
            "Gain": {"MinValue": 0, "MaxValue": 570},
            "Exposure": {"MinValue": 32, "MaxValue": 2000000000},
        }

    def set_roi(self, **kwargs):
        self.calls.append(("set_roi", kwargs))

    def set_control_value(self, control, value):
        self.calls.append(("set_control_value", control, value))

    def start_exposure(self):
        self.calls.append(("start_exposure",))

    def get_exposure_status(self):
        return self.module.status

    def get_data_after_exposure(self):
        return bytearray(b"\x01\x00\x02\x00")

    def stop_exposure(self):
        self.calls.append(("stop_exposure",))

    def close(self):
        self.calls.append(("close",))


@pytest.fixture
def zwoasi(monkeypatch):
    module = types.ModuleType("zwoasi")
    module.ASI_GAIN, module.ASI_EXPOSURE, module.ASI_IMG_RAW16 = 0, 1, 2
    module.zwolib = None
    module.init_calls = []
    module.opened = []
    module.status = 1
    module.cameras = ["ZWO ASI120MM", "ZWO ASI585MC"]

    def init(path):
        module.init_calls.append(path)
        module.zwolib = object()

    module.init = init
    module.list_cameras = lambda: module.cameras
    module.Camera = lambda index: _FakeZwoasiCamera(module, index)
    monkeypatch.setitem(sys.modules, "zwoasi", module)
    return module


def test_the_adapter_opens_the_one_named_camera_for_full_frame_raw16(zwoasi):
    adapter = ZwoasiCamera("/opt/asi/libASICamera2.so")

    info = adapter.open()

    assert zwoasi.init_calls == ["/opt/asi/libASICamera2.so"]
    assert zwoasi.opened[0].index == 1
    assert zwoasi.opened[0].calls == [("set_roi", {"bins": 1, "image_type": 2})]
    assert (info.width_px, info.height_px, info.gain_max, info.exposure_min_us) == (
        3840,
        2160,
        570,
        32,
    )


def test_the_sdk_library_is_initialised_once_per_process(zwoasi):
    ZwoasiCamera("/lib.so").open()
    ZwoasiCamera("/lib.so").open()
    assert len(zwoasi.init_calls) == 1


@pytest.mark.parametrize("cameras", [[], ["ZWO ASI585MC", "ZWO ASI585MC"]])
def test_no_camera_or_two_of_them_is_refused(zwoasi, cameras):
    zwoasi.cameras = cameras
    with pytest.raises(DeviceError, match="exactly one"):
        ZwoasiCamera("/lib.so").open()


def test_the_adapter_sets_exposure_in_microseconds_and_gain_before_starting(zwoasi):
    adapter = ZwoasiCamera("/lib.so")
    adapter.open()

    adapter.start_exposure(2_000_000, 300)

    assert zwoasi.opened[0].calls[1:] == [
        ("set_control_value", 1, 2_000_000),
        ("set_control_value", 0, 300),
        ("start_exposure",),
    ]


@pytest.mark.parametrize(
    ("raw", "state"),
    [
        (0, ExposureState.IDLE),
        (1, ExposureState.WORKING),
        (2, ExposureState.SUCCESS),
        (3, ExposureState.FAILED),
    ],
)
def test_the_sdk_exposure_status_maps_in_order(zwoasi, raw, state):
    adapter = ZwoasiCamera("/lib.so")
    adapter.open()
    zwoasi.status = raw
    assert adapter.exposure_state() is state


def test_a_binding_error_leaves_as_a_device_error(zwoasi):
    adapter = ZwoasiCamera("/lib.so")
    adapter.open()

    def broken():
        raise RuntimeError("ASI_ERROR_TIMEOUT")

    zwoasi.opened[0].start_exposure = broken
    with pytest.raises(DeviceError, match="ASI_ERROR_TIMEOUT"):
        adapter.start_exposure(1000, 0)


def test_a_missing_binding_is_a_device_error(monkeypatch):
    monkeypatch.setitem(sys.modules, "zwoasi", None)
    with pytest.raises(DeviceError, match="not installed"):
        ZwoasiCamera("/lib.so").open()


def test_nothing_imports_the_binding_until_a_camera_is_opened():
    """The agent starts, and the simulator runs, on a machine with no SDK at all."""
    probe = (
        "import sys, darkview_agent.devices.zwo, darkview_agent.devices.zwoasi_binding; "
        "assert 'zwoasi' not in sys.modules"
    )
    subprocess.run([sys.executable, "-c", probe], check=True, cwd=Path(__file__).parents[1])
