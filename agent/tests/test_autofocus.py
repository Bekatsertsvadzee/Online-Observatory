"""DV-031: autofocus and backlash-compensated focuser moves, on the simulator.

The simulated focuser keeps the optics apart from the motor by its backlash, and
the simulated camera blurs the field by how far the optics -- not the motor --
are from focus. So a routine that ignored backlash would report success here and
leave the stars soft, which is what these tests look for.

What the simulator cannot say is how the real motor's backlash, step size and
critical focus zone compare with these numbers. That is measured at first light.
"""

from __future__ import annotations

import numpy as np
import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.focus.autofocus import (
    Autofocus,
    FocusMove,
    approach,
    half_flux_radius,
)

BEST = SimCamera.BEST_FOCUS_POSITION
POINTINGS = [(50.0, 120.0), (40.0, 200.0), (60.0, 300.0), (35.0, 20.0)]


def _rig(position: int, backlash: int = 45, pointing=(50.0, 120.0)):
    clock = ManualClock()
    mount = SimMount(clock=clock)
    mount.connect()
    mount.unpark()
    mount.slew_to(*pointing)
    clock.advance(600.0)
    focuser = SimFocuser(clock=clock, position=position, backlash_steps=backlash)
    focuser.connect()
    camera = SimCamera(clock=clock, mount=mount, width_px=400, height_px=300, focuser=focuser)
    camera.connect()
    return clock, focuser, camera


def _run(clock: ManualClock, pumpable, limit: int = 1000):
    for _ in range(limit):
        outcome = pumpable.pump()
        if outcome:
            return outcome
        clock.advance(0.5)
    raise AssertionError("did not finish")


def _star_size(clock: ManualClock, camera: SimCamera) -> float:
    camera.expose(2000.0, 200)
    clock.advance(3.0)
    size = half_flux_radius(camera.read_frame().pixels)
    assert size is not None
    return size


def _size_at_best_focus(pointing) -> float:
    clock, _, camera = _rig(BEST, pointing=pointing)
    return _star_size(clock, camera)


# --------------------------------------------------------------------------
# Star size
# --------------------------------------------------------------------------


def test_star_size_grows_either_side_of_focus():
    sizes = {}
    for offset in (-800, -400, 0, 400, 800):
        clock, _, camera = _rig(BEST + offset)
        sizes[offset] = _star_size(clock, camera)

    assert sizes[0] < sizes[400] < sizes[800]
    assert sizes[0] < sizes[-400] < sizes[-800]


def test_a_frame_with_no_stars_has_no_star_size():
    sky = np.random.default_rng(7).normal(900.0, 60.0, (300, 400))
    assert half_flux_radius(np.clip(sky, 0, 65535).astype(np.uint16)) is None


# --------------------------------------------------------------------------
# Moves
# --------------------------------------------------------------------------


def test_an_outward_move_goes_straight_there():
    assert approach(15000, 15500, 100) == [15500]


def test_an_inward_move_overshoots_and_comes_back_out():
    assert approach(15500, 15000, 100) == [14900, 15000]


def test_the_overshoot_stops_at_the_end_of_travel():
    assert approach(500, 50, 100) == [0, 50]


def test_a_position_reached_from_either_side_puts_the_optics_in_one_place():
    """The contract's ABSOLUTE mode: 'a same-direction final approach'."""
    from_below_clock, from_below, _ = _rig(15000, backlash=250)
    _run(from_below_clock, FocusMove(from_below, 16000, overshoot=300))

    from_above_clock, from_above, _ = _rig(17000, backlash=250)
    _run(from_above_clock, FocusMove(from_above, 16000, overshoot=300))

    assert from_below.status().position == from_above.status().position == 16000
    assert from_below.optical_position == from_above.optical_position


def test_a_position_outside_the_travel_is_refused():
    _, focuser, _ = _rig(16000)
    with pytest.raises(ValueError):
        FocusMove(focuser, focuser.status().max_position + 1)


# --------------------------------------------------------------------------
# Autofocus
# --------------------------------------------------------------------------


@pytest.mark.parametrize("pointing", POINTINGS)
@pytest.mark.parametrize("start", [15700, 16300])
def test_autofocus_leaves_the_stars_as_small_as_best_focus_does(pointing, start):
    clock, focuser, camera = _rig(start, pointing=pointing)

    result = _run(clock, Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200))

    assert result.succeeded, result.detail
    assert focuser.status().position == result.position
    assert _star_size(clock, camera) <= 1.10 * _size_at_best_focus(pointing)


@pytest.mark.parametrize("pointing", POINTINGS)
def test_autofocus_is_not_fooled_by_backlash(pointing):
    """600 steps of slack is three pixels of blur if the last move ends inward."""
    clock, focuser, camera = _rig(16900, backlash=600, pointing=pointing)

    result = _run(
        clock,
        Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200, overshoot=700),
    )

    assert result.succeeded, result.detail
    assert _star_size(clock, camera) <= 1.10 * _size_at_best_focus(pointing)


def test_best_focus_outside_the_sampled_range_is_a_failure_that_returns_home():
    clock, focuser, camera = _rig(14500)

    result = _run(clock, Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200))

    # Either the fitted minimum lies past the samples or the curve only falls.
    assert result.succeeded is False
    assert "sampled" in result.detail
    assert result.position == 14500
    assert focuser.status().position == 14500
    assert len(result.samples) == 7


def test_a_minimum_just_past_the_samples_is_not_extrapolated_to(monkeypatch):
    """A clean curve bottoming out 300 steps past the last sample."""
    clock, focuser, camera = _rig(15100)
    monkeypatch.setattr(
        "darkview_agent.focus.autofocus.half_flux_radius",
        lambda pixels: float(np.hypot(2.0, (focuser.status().position - 16000) / 200.0)),
    )

    result = _run(clock, Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200))

    assert result.succeeded is False
    assert "outside the sampled range" in result.detail
    assert focuser.status().position == 15100


def test_a_cloudy_sky_is_a_failure_that_returns_home(monkeypatch):
    clock, focuser, camera = _rig(15900)
    monkeypatch.setattr("darkview_agent.focus.autofocus.half_flux_radius", lambda pixels: None)

    result = _run(clock, Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200))

    assert result.succeeded is False
    assert "enough stars" in result.detail
    assert focuser.status().position == 15900


def test_every_sample_is_reached_travelling_outward():
    clock, focuser, camera = _rig(16300)
    moves: list[int] = []
    original = focuser.move_to

    def recording(position: int) -> None:
        moves.append(position)
        original(position)

    focuser.move_to = recording
    result = _run(clock, Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200))

    sampled = [position for position, _ in result.samples]
    assert sampled == sorted(sampled)
    for position in sampled[1:] + [result.position]:
        index = moves.index(position)
        assert index == 0 or moves[index - 1] <= position


def test_cancel_stops_the_motor_and_the_exposure():
    clock, focuser, camera = _rig(16300)
    autofocus = Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200)
    autofocus.pump()
    assert focuser.status().moving is True

    autofocus.cancel()

    assert focuser.status().moving is False
    assert camera.status().exposing is False
    assert autofocus.pump().succeeded is False


def test_the_sampling_window_slides_to_fit_the_travel():
    _, focuser, camera = _rig(SimFocuser.MAX_POSITION - 50)
    autofocus = Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200)
    assert max(autofocus._positions) == SimFocuser.MAX_POSITION


def test_too_few_samples_are_refused():
    _, focuser, camera = _rig(16000)
    with pytest.raises(ValueError):
        Autofocus(focuser, camera, exposure_milliseconds=2000.0, gain=200, samples=3)
