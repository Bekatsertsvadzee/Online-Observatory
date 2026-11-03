"""ADR-080 §1 -- the panel's scene logic, ported, against simulator frames.

Every fault the watch must recognise is produced here by `SimCamera` on demand:
a blank frame, a saturated one, cloud, and a bright disc that can be moved.
"""

from __future__ import annotations

import pytest

from contracts.models import ImagingProfile, OpticalConfig
from darkview_agent.capture import scene
from darkview_agent.capture.profiles import EXPOSURE_RANGES, PROFILES
from darkview_agent.clock import ManualClock
from darkview_agent.devices.simulated import SimCamera, SimMount
from darkview_agent.runtime import field_height_degrees

ALTITUDE = 50.0
AZIMUTH = 200.0


def pointed_camera(width_px: int = 320, height_px: int = 240) -> tuple[SimCamera, ManualClock]:
    clock = ManualClock()
    mount = SimMount(clock)
    mount.connect()
    mount.unpark()
    mount.slew_to(ALTITUDE, AZIMUTH)
    clock.advance(120.0)
    camera = SimCamera(clock, mount, width_px=width_px, height_px=height_px)
    camera.connect()
    return camera, clock


def shoot(camera: SimCamera, clock: ManualClock, exposure_milliseconds: float, gain: int):
    camera.expose(exposure_milliseconds, gain)
    clock.advance(exposure_milliseconds / 1000.0 + 0.01)
    return camera.read_frame()


def auto_expose(camera, clock, profile: ImagingProfile) -> scene.AutoExposure:
    settings = PROFILES[profile]
    run = scene.AutoExposure(profile, settings.exposure_milliseconds, settings.gain)
    while not run.feed(scene.stats(shoot(camera, clock, *run.settings))):
        pass
    return run


def test_a_star_field_is_recognised_as_one():
    camera, clock = pointed_camera()
    measured = scene.stats(shoot(camera, clock, 2000.0, 200))

    assert measured.stars >= 30
    assert measured.blob == 0.0, "star cores must not read as a disc"
    assert scene.classify(measured, "cluster") == "cluster"
    assert scene.classify(measured, "deepsky") == "deepsky"


def test_a_blank_frame_has_nothing_above_its_background():
    camera, clock = pointed_camera()
    camera.blank_frames(1)
    measured = scene.stats(shoot(camera, clock, 2000.0, 200))

    assert measured.peak - measured.median < 0.02
    assert measured.stars == 0
    # The fault lasts exactly as long as it was asked to.
    assert scene.stats(shoot(camera, clock, 2000.0, 200)).stars > 0


def test_a_saturated_frame_is_clipped():
    camera, clock = pointed_camera()
    camera.saturate_frames(1)
    measured = scene.stats(shoot(camera, clock, 2000.0, 200))

    assert measured.clip > 0.25
    assert scene.classify(measured, "cluster") == "daylight"


def test_cloud_dims_the_stars_and_lifts_the_sky():
    camera, clock = pointed_camera()
    clear = scene.stats(shoot(camera, clock, 2000.0, 200))
    camera.set_clouds(star_transmission=0.1, sky_glow=2.0)
    cloudy = scene.stats(shoot(camera, clock, 2000.0, 200))
    camera.clear_clouds()

    assert cloudy.stars < 0.3 * clear.stars
    assert cloudy.bg >= 1.5 * clear.bg


def test_the_moon_is_a_disc_and_its_centroid_is_where_it_is():
    camera, clock = pointed_camera()
    camera.show_disc(ALTITUDE, AZIMUTH, radius_px=60)
    frame = shoot(camera, clock, 8.0, 0)
    measured = scene.stats(frame)

    assert scene.classify(measured, "moon") == "moon"
    disc = scene.disc_centroid(frame)
    assert disc is not None
    assert abs(disc.dx_px) < 2 and abs(disc.dy_px) < 2

    # Below the frame centre: the disc sits lower in altitude than the mount.
    degrees_per_pixel = field_height_degrees(OpticalConfig.f10_native) / frame.height_px
    camera.move_disc(altitude_degrees=-30 * degrees_per_pixel)
    moved = scene.disc_centroid(shoot(camera, clock, 8.0, 0))
    assert moved is not None
    assert moved.dy_px == pytest.approx(30, abs=2)
    assert abs(moved.dx_px) < 2


def test_no_disc_in_the_frame_is_none_not_a_guess():
    camera, clock = pointed_camera()
    assert scene.disc_centroid(shoot(camera, clock, 8.0, 0)) is None


def test_auto_exposure_brings_the_moon_to_its_goal():
    camera, clock = pointed_camera()
    camera.show_disc(ALTITUDE, AZIMUTH, radius_px=60)
    run = auto_expose(camera, clock, ImagingProfile.lunar)

    assert run.scene == "moon"
    peak = scene.stats(shoot(camera, clock, *run.settings)).peak
    assert 0.8 * 0.85 <= peak < 0.99


def test_auto_exposure_darkens_a_blown_out_moon():
    camera, clock = pointed_camera()
    camera.show_disc(ALTITUDE, AZIMUTH, radius_px=60, brightness=60_000_000.0)
    run = auto_expose(camera, clock, ImagingProfile.lunar)

    assert run.exposure_milliseconds < PROFILES[ImagingProfile.lunar].exposure_milliseconds
    assert scene.stats(shoot(camera, clock, *run.settings)).clip < 0.02


def test_auto_exposure_sets_a_star_field_to_its_background_goal():
    camera, clock = pointed_camera()
    run = auto_expose(camera, clock, ImagingProfile.globular_cluster)

    assert run.scene == "cluster"
    background = scene.stats(shoot(camera, clock, *run.settings)).bg
    # Inside the band the panel's `ae_loop` leaves alone.
    goal = scene.AE["cluster"].goal
    assert goal * 0.6 < background < goal * 1.6


@pytest.mark.parametrize("profile", list(ImagingProfile))
def test_auto_exposure_never_leaves_the_profile_range(profile):
    """The profile's range wins over the panel's table (ADR-080 §1)."""
    camera, clock = pointed_camera()
    camera.blank_frames(20)  # nothing to see: the run walks to a limit
    run = auto_expose(camera, clock, profile)

    low, high = EXPOSURE_RANGES[profile]
    assert low <= run.exposure_milliseconds <= high
    assert run.tries <= scene.MAX_AUTO_EXPOSE_TRIES


def test_every_profile_names_a_scene_and_its_settings_lie_in_its_range():
    for profile, settings in PROFILES.items():
        assert scene.SCENE_FOR_PROFILE[profile] in scene.AE
        low, high = EXPOSURE_RANGES[profile]
        assert low <= settings.exposure_milliseconds <= high


def test_drift_is_two_sided_around_the_goal():
    camera, clock = pointed_camera()
    run = auto_expose(camera, clock, ImagingProfile.globular_cluster)
    on_goal = scene.stats(shoot(camera, clock, *run.settings))
    assert not scene.drifted(on_goal, "cluster", "cluster")

    exposure, gain = run.settings
    too_dark = scene.stats(shoot(camera, clock, exposure / 3, gain))
    assert scene.drifted(too_dark, "cluster", "cluster")
