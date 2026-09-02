import numpy as np
import pytest

from contracts.models import ObservatoryMode
from darkview_agent.clock import ManualClock
from darkview_agent.devices.simulated import SimCamera, SimMount


def exposed_frame(camera: SimCamera, clock: ManualClock, exposure_ms=1000.0, gain=150):
    camera.expose(exposure_ms, gain)
    clock.advance(exposure_ms / 1000.0 + 0.01)
    return camera.read_frame()


def test_exposure_takes_the_requested_time():
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=160, height_px=120)
    camera.connect()

    camera.expose(3000.0, 100)
    clock.advance(2.9)
    assert camera.exposure_complete() is False

    clock.advance(0.2)
    assert camera.exposure_complete() is True


def test_frame_pixels_are_sensor_shaped():
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=320, height_px=240)
    camera.connect()

    frame = exposed_frame(camera, clock)

    assert frame.pixels.shape == (240, 320)
    assert frame.pixels.dtype == np.uint16
    assert frame.width_px == 320
    assert frame.height_px == 240


def test_every_frame_is_labelled_simulated():
    """Criterion 4. A frame that loses its provenance can be shown as the real sky."""
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=64, height_px=64)
    camera.connect()

    frame = exposed_frame(camera, clock)

    assert frame.mode is ObservatoryMode.simulated
    assert frame.is_simulated is True
    assert camera.status().mode is ObservatoryMode.simulated


def test_the_field_contains_actual_stars():
    """Criterion 3: point sources well above background, not uniform noise."""
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=640, height_px=480)
    camera.connect()

    pixels = exposed_frame(camera, clock).pixels
    background = float(np.median(pixels))
    brightest = float(pixels.max())

    assert brightest > background * 2.0, "no star stands out from the background"
    bright_pixels = int((pixels > background * 1.5).sum())
    assert 20 < bright_pixels < pixels.size * 0.1, (
        f"expected sparse point sources, {bright_pixels} bright pixels of {pixels.size}"
    )


def test_the_same_pointing_produces_the_same_field():
    """Determinism: DV-030 needs a repeatable field to plate-solve against."""
    results = []
    for _ in range(2):
        clock = ManualClock()
        mount = SimMount(clock=clock)
        mount.connect()
        mount.unpark()
        mount.slew_to(45.0, 120.0)
        clock.advance(600.0)

        camera = SimCamera(clock=clock, mount=mount, width_px=128, height_px=128)
        camera.connect()
        results.append(exposed_frame(camera, clock).pixels)

    assert np.array_equal(results[0], results[1])


def test_a_different_pointing_produces_a_different_field():
    """A frame is evidence of where the telescope actually is."""
    frames = {}
    for altitude, azimuth in ((45.0, 120.0), (60.0, 200.0)):
        clock = ManualClock()
        mount = SimMount(clock=clock)
        mount.connect()
        mount.unpark()
        mount.slew_to(altitude, azimuth)
        clock.advance(600.0)

        camera = SimCamera(clock=clock, mount=mount, width_px=128, height_px=128)
        camera.connect()
        frames[(altitude, azimuth)] = exposed_frame(camera, clock).pixels

    first, second = list(frames.values())
    assert not np.array_equal(first, second)


def test_longer_exposure_collects_more_signal():
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=128, height_px=128)
    camera.connect()

    short = float(np.median(exposed_frame(camera, clock, exposure_ms=500.0).pixels))
    long = float(np.median(exposed_frame(camera, clock, exposure_ms=4000.0).pixels))

    assert long > short


def test_higher_gain_brightens_the_frame():
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=128, height_px=128)
    camera.connect()

    low = float(np.median(exposed_frame(camera, clock, gain=50).pixels))
    high = float(np.median(exposed_frame(camera, clock, gain=400).pixels))

    assert high > low


def test_pixels_stay_within_the_sensor_range():
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=128, height_px=128)
    camera.connect()

    pixels = exposed_frame(camera, clock, exposure_ms=30000.0, gain=600).pixels

    assert pixels.min() >= 0
    assert pixels.max() <= 65535


def test_aborted_exposure_cannot_be_read():
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=64, height_px=64)
    camera.connect()

    camera.expose(1000.0, 100)
    camera.abort_exposure()
    clock.advance(5.0)

    assert camera.exposure_complete() is False
    with pytest.raises(ValueError):
        camera.read_frame()


def test_reading_a_frame_consumes_it():
    clock = ManualClock()
    camera = SimCamera(clock=clock, width_px=64, height_px=64)
    camera.connect()

    exposed_frame(camera, clock)
    with pytest.raises(ValueError):
        camera.read_frame()
