"""DV-033 — live stacking.

Every test builds its own synthetic sky, so the numbers below are properties of
the algorithm rather than of any particular camera. What they cannot tell us is
whether the thresholds are right for the real ASI585MC on the real rooftop; that
is DV-035's, and the thresholds say so where they are defined.
"""

from __future__ import annotations

from datetime import UTC, datetime

import numpy as np
import pytest

from contracts.models import ObservatoryMode
from darkview_agent.capture.stack import (
    LiveStack,
    align_shift,
    background_and_noise,
    integration_seconds,
    shift_image,
)
from darkview_agent.devices.frame import Frame

HEIGHT = 96
WIDTH = 128
SKY = 1000
READ_NOISE = 40.0


def star_field(
    *,
    shift_yx: tuple[int, int] = (0, 0),
    seed: int = 0,
    sky: int = SKY,
    extra: list[tuple[int, int, int]] | None = None,
) -> np.ndarray:
    """A repeatable sky: a flat background, some stars, and fresh noise."""
    rng = np.random.default_rng(seed)
    pixels = np.full((HEIGHT, WIDTH), float(sky))

    stars = [(20, 30, 9000), (55, 88, 6000), (70, 20, 4000), (35, 100, 12000)]
    dy, dx = shift_yx
    for y, x, brightness in stars:
        yy, xx = y + dy, x + dx
        if 1 <= yy < HEIGHT - 1 and 1 <= xx < WIDTH - 1:
            # A small cross, so a star is more than one pixel and alignment has
            # something with structure to lock onto.
            pixels[yy, xx] += brightness
            pixels[yy - 1 : yy + 2, xx] += brightness * 0.4
            pixels[yy, xx - 1 : xx + 2] += brightness * 0.4

    for y, x, brightness in extra or []:
        pixels[y, x] += brightness

    pixels += rng.normal(0.0, READ_NOISE, pixels.shape)
    return np.clip(pixels, 0, 65535).astype(np.uint16)


def frame_from(pixels: np.ndarray, exposure: float = 2000.0) -> Frame:
    return Frame(
        pixels=pixels,
        exposure_milliseconds=exposure,
        gain=200,
        captured_at=datetime.now(UTC),
        mode=ObservatoryMode.simulated,
    )


class TestAlignment:
    @pytest.mark.parametrize(
        "drift", [(0, 0), (3, 5), (-4, 7), (6, -9), (-8, -2), (1, 0), (0, -1)]
    )
    def test_recovers_a_known_translation(self, drift: tuple[int, int]) -> None:
        # `align_shift` returns the CORRECTION, which is the negation of the
        # drift: a field that moved three rows down needs -3 to put it back.
        reference = star_field(seed=1)
        moved = star_field(shift_yx=drift, seed=2)

        assert align_shift(reference, moved) == (-drift[0], -drift[1])

    def test_shifting_back_restores_the_original_positions(self) -> None:
        reference = star_field(seed=1)
        moved = star_field(shift_yx=(5, -6), seed=1)

        dy, dx = align_shift(reference, moved)
        restored = shift_image(moved, dy, dx)

        # The brightest pixel is back where the reference has it.
        assert np.unravel_index(int(np.argmax(restored)), restored.shape) == (
            np.unravel_index(int(np.argmax(reference)), reference.shape)
        )

    def test_fills_the_vacated_edge_with_the_median_not_black(self) -> None:
        # A zero-filled edge is the darkest thing in the frame, and the live
        # view's autostretch anchors on the median -- so a black band would drag
        # the stretch and make the picture pulse as the mount drifts.
        pixels = star_field(seed=3)
        shifted = shift_image(pixels, 4, 0)

        assert shifted[0:4, :].min() > 0
        assert abs(float(np.median(shifted[0:4, :])) - float(np.median(pixels))) < 5


class TestStacking:
    def test_the_first_frame_is_the_stack(self) -> None:
        stack = LiveStack()
        result = stack.add(frame_from(star_field(seed=1)))

        assert result.accepted
        assert result.frames_stacked == 1
        assert result.frame.stacked_frames == 1

    def test_averaging_reduces_the_noise(self) -> None:
        # The point of the whole module. Signal is the same every frame and adds;
        # noise is different every frame and partly cancels. Sixteen frames should
        # roughly halve the background spread, or better.
        stack = LiveStack()
        single = star_field(seed=0)
        _, single_noise = background_and_noise(single)

        result = stack.add(frame_from(single))
        for seed in range(1, 16):
            result = stack.add(frame_from(star_field(seed=seed)))

        assert result.frames_stacked == 16
        _, stacked_noise = background_and_noise(result.frame.pixels)
        assert stacked_noise < single_noise / 2

    def test_keeps_the_background_on_the_same_scale(self) -> None:
        # Mean, not sum. A sum would overflow uint16 within a few frames and would
        # also march the background upward, so the autostretch would be chasing it
        # and the live view would pulse.
        stack = LiveStack()
        result = stack.add(frame_from(star_field(seed=0)))
        first_background, _ = background_and_noise(result.frame.pixels)

        for seed in range(1, 30):
            result = stack.add(frame_from(star_field(seed=seed)))

        stacked_background, _ = background_and_noise(result.frame.pixels)
        assert abs(stacked_background - first_background) < 20
        assert result.frame.pixels.max() < 65535

    def test_aligns_a_drifting_field_instead_of_smearing_it(self) -> None:
        # The failure this exists to prevent: averaging a drifting star field
        # without aligning it turns every star into a streak, and the result is a
        # worse picture than the single frame it started from.
        drifted = [star_field(shift_yx=(i, i), seed=i) for i in range(8)]

        aligned = LiveStack()
        for pixels in drifted:
            result = aligned.add(frame_from(pixels))

        naive = np.mean([p.astype(np.float64) for p in drifted], axis=0)

        # A star stays a point when aligned and spreads when it is not, so the
        # aligned stack keeps a far higher peak above its own background.
        aligned_background, _ = background_and_noise(result.frame.pixels)
        naive_background, _ = background_and_noise(naive.astype(np.uint16))
        aligned_peak = float(result.frame.pixels.max()) - aligned_background
        naive_peak = float(naive.max()) - naive_background

        assert result.frames_stacked == 8
        assert aligned_peak > naive_peak * 1.5

    def test_reports_both_the_correction_and_the_drift(self) -> None:
        # The two signs are easy to confuse and only one of them is what an
        # operator wants to read, so both are named.
        stack = LiveStack()
        stack.add(frame_from(star_field(seed=0)))
        result = stack.add(frame_from(star_field(shift_yx=(3, -4), seed=1)))

        assert result.correction_yx == (-3, 4)
        assert result.drift_yx == (3, -4)

    def test_carries_the_sub_exposure_not_the_total(self) -> None:
        # LiveFrameHeader.exposureMilliseconds sits beside stackedFrames and means
        # how long each sub was. Reporting the total here would be claiming a long
        # exposure, which is the thing Phase 1 explicitly does not offer.
        stack = LiveStack()
        for seed in range(5):
            result = stack.add(frame_from(star_field(seed=seed), exposure=2500.0))

        assert result.frame.exposure_milliseconds == 2500.0
        assert result.frame.stacked_frames == 5
        assert integration_seconds(2500.0, 5) == 12.5


class TestRejection:
    def test_refuses_a_frame_the_cloud_ruined(self) -> None:
        stack = LiveStack()
        for seed in range(4):
            stack.add(frame_from(star_field(seed=seed)))

        clouded = stack.add(frame_from(star_field(seed=99, sky=SKY + 3000)))

        assert not clouded.accepted
        assert clouded.rejection is not None
        assert clouded.frames_stacked == 4

    def test_a_rejected_frame_still_shows_the_stack_so_far(self) -> None:
        # Blanking the live view because a satellite went past is worse than not
        # improving for a second.
        stack = LiveStack()
        stack.add(frame_from(star_field(seed=0)))
        rejected = stack.add(frame_from(star_field(seed=1, sky=SKY + 5000)))

        assert rejected.frame.stacked_frames == 1
        assert rejected.frame.pixels.shape == (HEIGHT, WIDTH)

    def test_refuses_a_shift_too_large_to_be_tracking_drift(self) -> None:
        # Phase correlation always returns a peak, including for frames that have
        # nothing in common. A mount that jumped an eighth of the field in one sub
        # was knocked, and what came after does not belong with what came before.
        stack = LiveStack(max_shift_fraction=0.02)
        stack.add(frame_from(star_field(seed=0)))

        knocked = stack.add(frame_from(star_field(shift_yx=(20, 30), seed=1)))

        assert not knocked.accepted
        assert knocked.frames_stacked == 1

    def test_a_bad_frame_never_enters_the_average(self) -> None:
        # Once averaged in it cannot be taken out, which is why the check is
        # before rather than after.
        clean = LiveStack()
        with_intruder = LiveStack()

        for seed in range(6):
            pixels = star_field(seed=seed)
            clean.add(frame_from(pixels))
            with_intruder.add(frame_from(pixels))

        with_intruder.add(frame_from(star_field(seed=7, sky=SKY + 4000)))

        clean_result = clean.add(frame_from(star_field(seed=8)))
        intruder_result = with_intruder.add(frame_from(star_field(seed=8)))

        assert np.array_equal(clean_result.frame.pixels, intruder_result.frame.pixels)


class TestReset:
    def test_a_slew_starts_a_new_stack(self) -> None:
        # A stack that survived a slew would average two different parts of the
        # sky into one image, which is not a worse picture of the target -- it is a
        # picture of nothing.
        stack = LiveStack()
        for seed in range(5):
            stack.add(frame_from(star_field(seed=seed)))
        assert stack.frames_stacked == 5

        stack.reset()
        result = stack.add(frame_from(star_field(seed=9)))

        assert result.frames_stacked == 1

    def test_a_changed_frame_size_starts_again_rather_than_failing(self) -> None:
        stack = LiveStack()
        stack.add(frame_from(star_field(seed=0)))

        smaller = np.full((HEIGHT // 2, WIDTH // 2), SKY, dtype=np.uint16)
        result = stack.add(frame_from(smaller))

        assert result.accepted
        assert result.frames_stacked == 1
        assert result.frame.pixels.shape == (HEIGHT // 2, WIDTH // 2)
