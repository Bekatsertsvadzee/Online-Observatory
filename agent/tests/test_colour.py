"""ADR-021 / issue #113: a one-shot colour frame becomes a picture, once.

The simulator is mono, so none of this could be found by running the agent. The
tests build the mosaic instead: take a known RGB image, throw away two of the
three colours at every pixel the way a Bayer filter does, and check what comes
back. That is the only way to state what "correct" means for a debayer without a
camera.
"""

from __future__ import annotations

import io
from datetime import UTC, datetime

import numpy as np
import pytest
from PIL import Image

from contracts.models import ObservatoryMode
from darkview_agent.capture import colour
from darkview_agent.capture.deliverable import render
from darkview_agent.capture.overlay import Caption
from darkview_agent.capture.stack import LiveStack
from darkview_agent.devices.frame import Frame
from darkview_agent.solve.astap import FITS_BLOCK, fits_bytes
from darkview_agent.stream.mjpeg import encode_frame

PATTERNS = sorted(colour.BAYER_PATTERNS)


def mosaic_of(rgb: np.ndarray, pattern: str) -> np.ndarray:
    """What a sensor with this colour filter would have measured from this scene."""
    height, width = rgb.shape[:2]
    out = np.zeros((height, width), dtype=np.uint16)
    for position, channel in enumerate(colour.BAYER_PATTERNS[pattern]):
        index = {"R": 0, "G": 1, "B": 2}[channel]
        out[position // 2 :: 2, position % 2 :: 2] = rgb[
            position // 2 :: 2, position % 2 :: 2, index
        ]
    return out


def frame_of(pixels: np.ndarray, pattern: str | None = None, **kwargs) -> Frame:
    return Frame(
        pixels=pixels,
        exposure_milliseconds=kwargs.pop("exposure_milliseconds", 2000.0),
        gain=kwargs.pop("gain", 100),
        captured_at=datetime(2026, 9, 17, 21, 0, tzinfo=UTC),
        mode=ObservatoryMode.real,
        bayer_pattern=pattern,
        **kwargs,
    )


def flat(height: int, width: int, rgb: tuple[int, int, int]) -> np.ndarray:
    scene = np.zeros((height, width, 3), dtype=np.uint16)
    scene[:, :] = rgb
    return scene


# --------------------------------------------------------------------------
# The frame says what it is
# --------------------------------------------------------------------------


def test_a_frame_defaults_to_no_colour_pattern():
    frame = frame_of(np.zeros((4, 4), dtype=np.uint16))
    assert frame.bayer_pattern is None
    assert frame.is_mosaic is False


@pytest.mark.parametrize("pattern", PATTERNS)
def test_a_frame_may_carry_any_bayer_pattern(pattern):
    assert frame_of(np.zeros((4, 4), dtype=np.uint16), pattern).is_mosaic is True


def test_a_pattern_that_is_not_one_is_refused():
    with pytest.raises(ValueError, match="Bayer"):
        frame_of(np.zeros((4, 4), dtype=np.uint16), "RGBG")


# --------------------------------------------------------------------------
# Debayering
# --------------------------------------------------------------------------


@pytest.mark.parametrize("pattern", PATTERNS)
def test_a_flat_colour_survives_the_round_trip(pattern):
    """Red stays red: the commonest way a debayer is wrong is the pattern's offset."""
    scene = flat(32, 32, (40000, 8000, 2000))

    rgb = colour.debayer(mosaic_of(scene, pattern), pattern)

    # Away from the edges, where a 3x3 window is complete.
    np.testing.assert_allclose(rgb[2:-2, 2:-2], scene[2:-2, 2:-2], atol=1)


@pytest.mark.parametrize("pattern", PATTERNS)
def test_a_measured_sample_is_never_replaced_by_an_interpolation(pattern):
    rng = np.random.default_rng(3)
    scene = rng.integers(0, 65535, (24, 24, 3), dtype=np.uint16)
    mosaic = mosaic_of(scene, pattern)

    rgb = colour.debayer(mosaic, pattern)

    for position, channel in enumerate(colour.BAYER_PATTERNS[pattern]):
        index = {"R": 0, "G": 1, "B": 2}[channel]
        measured = rgb[position // 2 :: 2, position % 2 :: 2, index]
        np.testing.assert_array_equal(measured, mosaic[position // 2 :: 2, position % 2 :: 2])


def test_a_gradient_is_interpolated_rather_than_blocked():
    """A smooth scene comes back smooth: no 2x2 staircase from the filter grid."""
    ramp = np.linspace(1000, 60000, 64).astype(np.uint16)
    scene = np.repeat(np.tile(ramp, (64, 1))[:, :, None], 3, axis=2)

    rgb = colour.debayer(mosaic_of(scene, "RGGB"), "RGGB")

    error = np.abs(rgb[4:-4, 4:-4].astype(int) - scene[4:-4, 4:-4].astype(int))
    assert error.max() < 1000  # one ramp step is ~930 ADU


def test_the_edges_are_interpolated_from_what_is_there():
    rgb = colour.debayer(mosaic_of(flat(16, 16, (30000, 20000, 10000)), "RGGB"), "RGGB")
    assert rgb.min() > 0
    assert rgb.shape == (16, 16, 3)


def test_a_pattern_the_module_does_not_know_is_refused():
    with pytest.raises(ValueError):
        colour.debayer(np.zeros((4, 4), dtype=np.uint16), "XYZW")


def test_a_frame_that_is_not_a_mosaic_passes_through_untouched():
    pixels = np.arange(16, dtype=np.uint16).reshape(4, 4)
    assert colour.to_display(frame_of(pixels)) is pixels


# --------------------------------------------------------------------------
# Stacking keeps the colours where they belong
# --------------------------------------------------------------------------


def _stripes(height: int, width: int, shift: int) -> np.ndarray:
    """A field whose stars are offset by `shift` rows, as a mosaic would see them."""
    scene = np.full((height, width, 3), 800, dtype=np.uint16)
    for row in range(6, height - 6, 8):
        scene[(row + shift) % height, 6:-6] = (50000, 12000, 3000)
    return scene


@pytest.mark.parametrize("drift", [1, 3, -1, -5])
def test_a_mosaic_is_only_ever_aligned_by_an_even_number_of_pixels(drift):
    """An odd correction lands red on green and averages the channels together."""
    stack = LiveStack()
    stack.add(frame_of(mosaic_of(_stripes(64, 64, 0), "RGGB"), "RGGB"))

    result = stack.add(frame_of(mosaic_of(_stripes(64, 64, drift), "RGGB"), "RGGB"))

    assert result.correction_yx[0] % 2 == 0
    assert result.correction_yx[1] % 2 == 0


def test_a_mono_frame_still_aligns_by_whole_pixels():
    stack = LiveStack()
    scene = _stripes(64, 64, 0)[:, :, 1]
    stack.add(frame_of(scene))

    result = stack.add(frame_of(_stripes(64, 64, 1)[:, :, 1]))

    assert result.accepted is True
    assert result.correction_yx[0] % 2 == 1


def test_stacking_a_drifting_mosaic_keeps_the_colour_it_started_with():
    """The defect in full: the stack must not turn a red field pink."""
    stack = LiveStack()
    for drift in (0, 2, 4, 2):
        scene = np.full((48, 48, 3), 600, dtype=np.uint16)
        scene[10 + drift : 30 + drift, 10:30] = (50000, 6000, 1500)
        result = stack.add(frame_of(mosaic_of(scene, "RGGB"), "RGGB"))

    rgb = colour.debayer(result.frame.pixels, "RGGB")
    patch = rgb[16:24, 14:26]
    assert patch[:, :, 0].mean() > 3 * patch[:, :, 1].mean()
    assert patch[:, :, 1].mean() > patch[:, :, 2].mean()


# --------------------------------------------------------------------------
# What a person is shown
# --------------------------------------------------------------------------


def test_the_live_view_sends_a_colour_jpeg_for_a_colour_frame():
    scene = flat(64, 64, (40000, 9000, 2500))
    encoded = encode_frame(frame_of(mosaic_of(scene, "RGGB"), "RGGB"))

    image = Image.open(io.BytesIO(encoded.payload))

    assert image.mode == "RGB"
    red, green, blue = image.convert("RGB").split()
    assert np.mean(np.asarray(red)) > np.mean(np.asarray(green)) > np.mean(np.asarray(blue))


def test_the_live_view_still_sends_greyscale_for_a_mono_frame():
    rng = np.random.default_rng(1)
    pixels = rng.integers(500, 4000, (64, 64), dtype=np.uint16)
    encoded = encode_frame(frame_of(pixels))
    assert Image.open(io.BytesIO(encoded.payload)).mode == "L"


def test_the_delivered_image_is_the_colour_the_customer_watched():
    scene = flat(64, 64, (40000, 9000, 2500))
    caption = Caption(
        captured_at=datetime(2026, 9, 17, 21, 0, tzinfo=UTC),
        integration_seconds=20.0,
        frames_stacked=10,
        mode=ObservatoryMode.real,
        optical_config="F10_NATIVE",
    )

    deliverable = render(frame_of(mosaic_of(scene, "RGGB"), "RGGB"), caption)

    image = Image.open(io.BytesIO(deliverable.unmarked.payload))
    red, green, blue = image.convert("RGB").split()
    assert np.mean(np.asarray(red)) > np.mean(np.asarray(green)) > np.mean(np.asarray(blue))


# --------------------------------------------------------------------------
# What the solver is told
# --------------------------------------------------------------------------


def test_the_fits_written_for_astap_declares_the_colour_pattern():
    written = fits_bytes(frame_of(np.zeros((8, 8), dtype=np.uint16), "GBRG"))
    header = written[:FITS_BLOCK].decode("ascii")
    assert "BAYERPAT= 'GBRG'" in header


def test_a_mono_frame_claims_no_pattern():
    written = fits_bytes(frame_of(np.zeros((8, 8), dtype=np.uint16)))
    assert "BAYERPAT" not in written[:FITS_BLOCK].decode("ascii")
