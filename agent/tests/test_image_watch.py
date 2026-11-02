"""ADR-080 §2-§4 -- the image watch's verdicts and its recovery ladder, alone.

No device, no runner: frames' verdicts and steps' outcomes go in at chosen
instants, and what the watch asks for next comes out.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from contracts.models import ImageHealth, ImageHealthReason, ImageHealthStatus, RecoveryStep
from darkview_agent.capture.scene import FrameStats
from darkview_agent.mission import watch as w
from darkview_agent.mission.watch import Baseline, ImageWatch, Need, judge

START = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)
LIMIT = 0.05


class Clocked:
    """One watch and the two clocks it is told."""

    def __init__(self, *, disc: bool = False) -> None:
        self.mono = 0.0
        self.watch = ImageWatch(START, 0.0, disc=disc)

    @property
    def at(self) -> datetime:
        return START + timedelta(seconds=self.mono)

    def tick(self, seconds: float) -> None:
        self.mono += seconds

    def frames(self, reason, count: int, every: float = 4.0) -> None:
        for _ in range(count):
            self.watch.frame(reason, self.at, self.mono)
            self.tick(every)

    def due(self) -> Need | None:
        return self.watch.due(self.at, self.mono)

    def solved(self, offset, **kwargs) -> None:
        self.watch.solved(offset, LIMIT, self.at, self.mono, **kwargs)

    def health(self) -> dict:
        health = self.watch.health()
        ImageHealth.model_validate(health)  # always the contract's shape
        return health


def stats(**overrides) -> FrameStats:
    values = dict(peak=0.4, median=0.08, bg=0.08, clip=0.0, blob=0.0, stars=60, top=1.0)
    values.update(overrides)
    return FrameStats(**values)


BASELINE = Baseline(stars=60, bg=0.08, peak=0.8, exposure_milliseconds=2000.0, gain=200)


def verdict(m: FrameStats, *, disc: bool = False, off_centre: bool = False, **kwargs):
    return judge(
        m,
        disc=disc,
        off_centre=off_centre,
        baseline=kwargs.pop("baseline", BASELINE),
        exposure_milliseconds=kwargs.pop("exposure_milliseconds", 2000.0),
        gain=kwargs.pop("gain", 200),
        **kwargs,
    )


# ----------------------------------------------------------------------
# One frame's verdict (§2)
# ----------------------------------------------------------------------


def test_a_good_frame_is_good():
    assert verdict(stats()) is None


def test_a_flat_frame_is_blank():
    assert verdict(stats(peak=0.0032, median=0.0030, stars=0)) is ImageHealthReason.blank_frame


def test_a_clipped_frame_is_overexposed():
    assert verdict(stats(clip=0.3)) is ImageHealthReason.overexposed


def test_a_blown_disc_is_overexposed_where_a_star_field_is_not():
    blown = stats(clip=0.03, blob=0.05, stars=0)
    assert verdict(blown, disc=True) is ImageHealthReason.overexposed
    assert verdict(stats(clip=0.03)) is None


def test_too_few_stars_on_an_unraised_sky_is_no_stars():
    assert verdict(stats(stars=2)) is ImageHealthReason.no_stars
    assert verdict(stats(stars=2), baseline=None) is ImageHealthReason.no_stars


def test_lost_stars_under_a_raised_sky_is_clouds():
    assert verdict(stats(stars=10, bg=0.16)) is ImageHealthReason.clouds
    # Fewer stars on the same sky is not cloud.
    assert verdict(stats(stars=10, bg=0.08)) is None


def test_a_dimmed_disc_at_the_same_settings_is_clouds():
    dim = stats(peak=0.25, stars=0, blob=0.05)
    assert verdict(dim, disc=True) is ImageHealthReason.clouds
    # Not at different settings: the peak would differ anyway.
    assert verdict(dim, disc=True, exposure_milliseconds=4.0) is None


def test_a_sky_sensor_reporting_cloud_is_clouds():
    assert verdict(stats(), sky_cloudy=True) is ImageHealthReason.clouds


def test_a_disc_off_centre_is_off_centre_and_a_star_field_never_is_from_one_frame():
    assert verdict(stats(stars=0, blob=0.05), disc=True, off_centre=True) is (
        ImageHealthReason.off_centre
    )
    assert verdict(stats(), off_centre=True) is None


# ----------------------------------------------------------------------
# Debounce (§2)
# ----------------------------------------------------------------------


def test_a_reason_needs_three_frames_and_ten_seconds():
    clocked = Clocked()
    clocked.frames(ImageHealthReason.blank_frame, 3, every=1.0)
    assert clocked.watch.status is ImageHealthStatus.ok, "three frames in two seconds"

    clocked = Clocked()
    clocked.frames(ImageHealthReason.blank_frame, 2, every=10.0)
    assert clocked.watch.status is ImageHealthStatus.ok, "two frames in twenty seconds"

    clocked.frames(ImageHealthReason.blank_frame, 1)
    assert clocked.watch.status is ImageHealthStatus.recovering
    health = clocked.health()
    assert health["reason"] == "BLANK_FRAME"
    assert health["step"] == "RE_EXPOSE"
    assert health["attempt"] == 1


def test_one_good_frame_restarts_the_debounce():
    clocked = Clocked()
    clocked.frames(ImageHealthReason.no_stars, 2, every=6.0)
    clocked.frames(None, 1)
    clocked.frames(ImageHealthReason.no_stars, 2, every=6.0)
    assert clocked.watch.status is ImageHealthStatus.ok


def test_two_good_frames_clear_a_recovery():
    clocked = Clocked()
    clocked.frames(ImageHealthReason.blank_frame, 3, every=5.0)
    assert clocked.due() is Need.AUTO_EXPOSE
    clocked.watch.auto_exposed()

    clocked.frames(None, 1)
    assert clocked.watch.status is ImageHealthStatus.recovering
    clocked.frames(None, 1)
    assert clocked.watch.status is ImageHealthStatus.ok
    assert clocked.health()["reason"] is None


# ----------------------------------------------------------------------
# The ladder (§3)
# ----------------------------------------------------------------------


def test_the_ladder_is_re_expose_then_re_solve_then_a_second_pass_then_unrecovered():
    clocked = Clocked()
    clocked.frames(ImageHealthReason.blank_frame, 3, every=5.0)
    steps = []
    for _ in range(2):
        assert clocked.due() is Need.AUTO_EXPOSE
        steps.append(clocked.health()["step"])
        clocked.watch.auto_exposed()
        clocked.frames(ImageHealthReason.blank_frame, 1)  # still blank: next rung
        assert clocked.due() is Need.SOLVE
        steps.append(clocked.health()["step"])
        clocked.solved(None)  # a flat frame never solves

    assert steps == ["RE_EXPOSE", "RE_SOLVE", "RE_EXPOSE", "RE_SOLVE"]
    health = clocked.health()
    assert health["status"] == "UNRECOVERED"
    assert health["reason"] == "BLANK_FRAME"
    assert health["nextRetryAt"] is not None
    assert clocked.watch.unrecovered


def test_unrecovered_rechecks_every_five_minutes_and_never_slews_without_a_solve():
    clocked = Clocked()
    clocked.watch.give_up(ImageHealthReason.off_centre, clocked.at, clocked.mono)

    clocked.tick(w.UNRECOVERED_RECHECK_SECONDS - 1)
    assert clocked.due() is None
    clocked.tick(1)
    assert clocked.due() is Need.AUTO_EXPOSE
    clocked.watch.auto_exposed()
    assert clocked.due() is Need.SOLVE
    clocked.solved(None)
    assert clocked.due() is None, "a failed solve is no reason to move the mount"
    assert clocked.watch.unrecovered

    clocked.tick(w.UNRECOVERED_RECHECK_SECONDS)
    assert clocked.due() is Need.AUTO_EXPOSE
    clocked.watch.auto_exposed()
    assert clocked.due() is Need.SOLVE
    clocked.solved(0.2)  # solved, and off: now a slew has a measurement behind it
    assert clocked.due() is Need.RECENTRE
    clocked.watch.recentred()
    assert clocked.due() is Need.SOLVE
    clocked.solved(0.01)
    assert clocked.watch.status is ImageHealthStatus.ok


def test_clouds_wait_and_retry_every_two_minutes():
    clocked = Clocked()
    clocked.frames(ImageHealthReason.clouds, 3, every=5.0)
    health = clocked.health()
    assert health["status"] == "WAITING"
    assert health["reason"] == "CLOUDS"
    assert health["step"] == "WAIT_FOR_SKY"
    assert clocked.due() is None, "waiting never moves the mount"

    # Still cloudy at the retry: wait again.
    first_retry = health["nextRetryAt"]
    clocked.tick(w.CLOUD_RETRY_SECONDS)
    assert clocked.due() is None
    assert clocked.health()["nextRetryAt"] != first_retry

    # The cloud passes: two good frames and the picture is OK.
    clocked.frames(None, 2)
    assert clocked.watch.status is ImageHealthStatus.ok


def test_a_cloud_that_leaves_a_different_problem_restarts_the_ladder_at_the_retry():
    clocked = Clocked()
    clocked.frames(ImageHealthReason.clouds, 3, every=5.0)
    clocked.frames(ImageHealthReason.no_stars, 1)
    clocked.tick(w.CLOUD_RETRY_SECONDS)
    assert clocked.due() is Need.AUTO_EXPOSE
    health = clocked.health()
    assert health["status"] == "RECOVERING"
    assert health["reason"] == "NO_STARS"


def test_a_solve_failing_twice_on_a_raised_sky_is_clouds():
    clocked = Clocked()
    clocked.frames(ImageHealthReason.no_stars, 3, every=5.0)
    assert clocked.due() is Need.AUTO_EXPOSE
    clocked.watch.auto_exposed()
    clocked.frames(ImageHealthReason.no_stars, 1)
    assert clocked.due() is Need.SOLVE
    clocked.solved(None, background_raised=True)
    assert clocked.due() is Need.AUTO_EXPOSE  # pass two
    clocked.watch.auto_exposed()
    clocked.frames(ImageHealthReason.no_stars, 1)
    assert clocked.due() is Need.SOLVE
    clocked.solved(None, background_raised=True)

    assert clocked.watch.status is ImageHealthStatus.waiting
    assert clocked.health()["reason"] == "CLOUDS"


def test_an_off_centre_solve_re_centres_at_most_three_times():
    clocked = Clocked()
    clocked.frames(None, 1)
    clocked.tick(w.PERIODIC_RESOLVE_SECONDS)
    assert clocked.due() is Need.SOLVE
    clocked.solved(0.3)
    assert clocked.health()["reason"] == "OFF_CENTRE"

    recentres = 0
    for _ in range(40):
        need = clocked.due()
        if need is Need.RECENTRE:
            recentres += 1
            clocked.watch.recentred()
        elif need is Need.SOLVE:
            clocked.solved(0.3)  # the mount never gets there
        elif need is Need.AUTO_EXPOSE:
            clocked.watch.auto_exposed()
            clocked.frames(ImageHealthReason.off_centre, 1)
        else:
            break
        clocked.tick(1.0)
    assert recentres <= 2 * w.MAX_RECENTRE_ITERATIONS
    assert clocked.watch.unrecovered


# ----------------------------------------------------------------------
# Never fighting the mount (§3) and staying centred (§4)
# ----------------------------------------------------------------------


def test_no_more_than_six_corrective_slews_in_ten_minutes():
    clocked = Clocked()
    slews = 0
    for _ in range(20):
        clocked.tick(w.PERIODIC_RESOLVE_SECONDS / 10)
        clocked.watch.reset(clocked.at, clocked.mono)  # as RECENTER would
        clocked.tick(w.PERIODIC_RESOLVE_SECONDS)
        assert clocked.due() is Need.SOLVE
        clocked.solved(0.3)
        if clocked.due() is Need.RECENTRE:
            slews += 1
            clocked.watch.recentred()
        if clocked.mono > w.CORRECTIVE_SLEW_WINDOW_SECONDS:
            break
    assert slews <= w.MAX_CORRECTIVE_SLEWS


def test_the_slew_budget_refills_as_the_window_rolls():
    clocked = Clocked()
    for _ in range(w.MAX_CORRECTIVE_SLEWS):
        clocked.watch.reset(clocked.at, clocked.mono)
        clocked.solved(0.3)
        assert clocked.due() is Need.RECENTRE
    clocked.watch.reset(clocked.at, clocked.mono)
    clocked.solved(0.3)
    assert clocked.due() is None, "the seventh slew inside ten minutes"

    clocked.tick(w.CORRECTIVE_SLEW_WINDOW_SECONDS)
    clocked.watch.reset(clocked.at, clocked.mono)
    clocked.solved(0.3)
    assert clocked.due() is Need.RECENTRE


def test_a_disc_is_corrected_at_most_every_thirty_seconds():
    clocked = Clocked(disc=True)
    clocked.frames(ImageHealthReason.off_centre, 3, every=5.0)
    assert clocked.due() is Need.SOLVE
    clocked.solved(0.3)
    assert clocked.due() is Need.RECENTRE
    clocked.watch.recentred()
    assert clocked.due() is Need.SOLVE
    clocked.solved(0.3)  # still off: another correction is wanted

    clocked.tick(w.CENTROID_CORRECTION_MIN_INTERVAL_SECONDS - 1)
    assert clocked.due() is None
    clocked.tick(1)
    assert clocked.due() is Need.RECENTRE


def test_deep_sky_is_re_solved_every_five_minutes_while_ok():
    clocked = Clocked()
    clocked.tick(w.PERIODIC_RESOLVE_SECONDS - 1)
    assert clocked.due() is None
    clocked.tick(1)
    assert clocked.due() is Need.SOLVE
    clocked.solved(0.01)
    assert clocked.watch.status is ImageHealthStatus.ok
    assert clocked.due() is None


def test_a_disc_is_not_plate_solved_on_a_timer():
    clocked = Clocked(disc=True)
    clocked.tick(w.PERIODIC_RESOLVE_SECONDS * 3)
    assert clocked.due() is None


def test_a_nudged_framing_is_not_re_centred():
    clocked = Clocked()
    clocked.watch.customer_moved()
    clocked.tick(w.PERIODIC_RESOLVE_SECONDS * 2)
    assert clocked.due() is None
    clocked.solved(0.3)
    assert clocked.watch.status is ImageHealthStatus.ok

    clocked.watch.reset(clocked.at, clocked.mono)  # RECENTER
    clocked.tick(w.PERIODIC_RESOLVE_SECONDS)
    assert clocked.due() is Need.SOLVE


def test_a_drifting_picture_is_auto_exposed_after_two_checks():
    clocked = Clocked()
    clocked.watch.frame(None, clocked.at, clocked.mono, drift=True)
    assert clocked.due() is None
    clocked.watch.frame(None, clocked.at, clocked.mono, drift=True)
    assert clocked.due() is Need.AUTO_EXPOSE
    assert clocked.watch.status is ImageHealthStatus.ok, "re-exposing is not a recovery"


def test_reset_rearms_a_given_up_object():
    clocked = Clocked()
    clocked.watch.give_up(ImageHealthReason.off_centre, clocked.at, clocked.mono)
    assert clocked.health()["status"] == "UNRECOVERED"
    clocked.watch.reset(clocked.at, clocked.mono)
    assert clocked.health() == {
        "status": "OK",
        "reason": None,
        "step": None,
        "attempt": None,
        "since": clocked.health()["since"],
        "nextRetryAt": None,
    }


@pytest.mark.parametrize(
    "reason, first",
    [
        (ImageHealthReason.blank_frame, RecoveryStep.re_expose),
        (ImageHealthReason.no_stars, RecoveryStep.re_expose),
        (ImageHealthReason.overexposed, RecoveryStep.re_expose),
    ],
)
def test_picture_problems_start_by_re_exposing(reason, first):
    clocked = Clocked()
    clocked.frames(reason, 3, every=5.0)
    assert clocked.health()["step"] == first.value
