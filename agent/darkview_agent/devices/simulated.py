"""Simulated devices — the default implementation, always.

These model timing rather than consuming it. A slew has a duration derived from
angular distance and slew rate; progress is computed from the clock each time
status is read. Nothing sleeps, so a test can drive a 90-degree slew, abort it
halfway, and assert the mount stopped where it actually was.

Every status and every frame these produce carries ObservatoryMode.simulated.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np

from contracts.models import DeviceHealth, ObservatoryMode, OpticalConfig
from darkview_agent.clock import Clock, SystemClock
from darkview_agent.devices import starfield
from darkview_agent.devices.base import (
    CameraDriver,
    CameraStatus,
    FocuserDriver,
    FocuserStatus,
    MountDriver,
    MountStatus,
    NotConnectedError,
)
from darkview_agent.devices.frame import Frame

# NexStar 8SE plausible values. DV-034 replaces these with figures measured from
# the physical mount. They are simulator behaviour, not safety limits: no number
# here ever gates a real slew.
SLEW_RATE_DEGREES_PER_SECOND = 4.0
SLEW_SETTLE_SECONDS = 1.5
PARK_ALTITUDE_DEGREES = 0.0
PARK_AZIMUTH_DEGREES = 0.0


def _angular_separation(
    from_altitude: float, from_azimuth: float, to_altitude: float, to_azimuth: float
) -> float:
    """Great-circle separation in degrees.

    Not the naive difference: near the zenith a large azimuth change is a small
    physical movement, and a mount that used the difference would report absurd
    slew times for a pointing directly overhead.
    """
    import math

    lat1, lon1 = math.radians(from_altitude), math.radians(from_azimuth)
    lat2, lon2 = math.radians(to_altitude), math.radians(to_azimuth)
    cosine = math.sin(lat1) * math.sin(lat2) + math.cos(lat1) * math.cos(lat2) * math.cos(
        lon2 - lon1
    )
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


class SimMount(MountDriver):
    def __init__(self, clock: Clock | None = None) -> None:
        self._clock = clock or SystemClock()
        self._connected = False
        self._tracking = False
        self._parked = True
        self._altitude = PARK_ALTITUDE_DEGREES
        self._azimuth = PARK_AZIMUTH_DEGREES
        self._slew_start: float | None = None
        self._slew_duration = 0.0
        self._slew_from: tuple[float, float] | None = None
        self._slew_to: tuple[float, float] | None = None

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.simulated

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self.abort_slew()
        self._connected = False

    def _require_connection(self) -> None:
        if not self._connected:
            raise NotConnectedError("mount is not connected")

    def _settle(self) -> None:
        """Advance the simulated slew to wherever the clock says it has reached."""
        if self._slew_start is None or self._slew_to is None or self._slew_from is None:
            return

        elapsed = self._clock.monotonic() - self._slew_start
        if elapsed >= self._slew_duration:
            self._altitude, self._azimuth = self._slew_to
            self._slew_start = None
            self._slew_from = None
            self._slew_to = None
            return

        fraction = 0.0 if self._slew_duration == 0 else elapsed / self._slew_duration
        from_altitude, from_azimuth = self._slew_from
        to_altitude, to_azimuth = self._slew_to
        self._altitude = from_altitude + (to_altitude - from_altitude) * fraction
        self._azimuth = from_azimuth + (to_azimuth - from_azimuth) * fraction

    def status(self) -> MountStatus:
        self._settle()
        return MountStatus(
            connected=self._connected,
            slewing=self._slew_start is not None,
            tracking=self._tracking,
            parked=self._parked,
            altitude_degrees=self._altitude,
            azimuth_degrees=self._azimuth,
            health=DeviceHealth.ok if self._connected else DeviceHealth.disconnected,
            mode=self.mode,
        )

    def slew_to(self, altitude_degrees: float, azimuth_degrees: float) -> None:
        self._require_connection()
        self._settle()

        separation = _angular_separation(
            self._altitude, self._azimuth, altitude_degrees, azimuth_degrees
        )
        self._slew_from = (self._altitude, self._azimuth)
        self._slew_to = (altitude_degrees, azimuth_degrees)
        self._slew_duration = separation / SLEW_RATE_DEGREES_PER_SECOND + SLEW_SETTLE_SECONDS
        self._slew_start = self._clock.monotonic()
        self._parked = False

    def abort_slew(self) -> None:
        """Stop where we are. Position keeps whatever the slew had reached."""
        self._settle()
        self._slew_start = None
        self._slew_from = None
        self._slew_to = None

    def park(self) -> None:
        """Always available, including while slewing and while disconnected.

        Park is the recovery action on heartbeat loss and device fault. A park
        that could itself fail because of connection state would be useless in
        exactly the situation it exists for.

        It stops motion inline rather than calling abort_slew(). Routing through
        another method means a park can fail because that method failed, and the
        one operation that must always work should not depend on anything else
        working first.
        """
        self._slew_start = None
        self._slew_from = None
        self._slew_to = None
        self._altitude = PARK_ALTITUDE_DEGREES
        self._azimuth = PARK_AZIMUTH_DEGREES
        self._tracking = False
        self._parked = True

    def unpark(self) -> None:
        self._require_connection()
        self._parked = False

    def set_tracking(self, tracking: bool) -> None:
        self._require_connection()
        if tracking and self._parked:
            raise NotConnectedError("cannot track while parked")
        self._tracking = tracking


@dataclass
class SimDisc:
    """A Moon or planet, fixed in the sky where the test put it."""

    altitude_degrees: float
    azimuth_degrees: float
    radius_px: float
    #: Disc brightness per second of exposure at gain 0, in ADU.
    brightness: float
    degrees_per_pixel: float


class SimCamera(CameraDriver):
    """A simulated ASI585MC.

    Renders the star field for wherever the mount is pointing, so a frame is
    evidence of where the telescope actually is.

    It can also be made to show what goes wrong on a real night (ADR-080), on
    demand: `blank_frames` and `saturate_frames` spoil the next few frames,
    `set_clouds` dims the stars and lifts the sky until cleared, and `show_disc`
    puts a bright disc at a fixed sky position that `move_disc` can drift.
    """

    DEFAULT_WIDTH_PX = 1920
    DEFAULT_HEIGHT_PX = 1080
    #: Where the simulated optical train is in focus, and how many focuser steps
    #: away from it widen a star by one pixel. Simulator behaviour, not a figure
    #: for the real 8SE; first light finds that one.
    BEST_FOCUS_POSITION = 16000
    STEPS_PER_PIXEL_OF_BLUR = 200.0

    def __init__(
        self,
        clock: Clock | None = None,
        mount: SimMount | None = None,
        width_px: int = DEFAULT_WIDTH_PX,
        height_px: int = DEFAULT_HEIGHT_PX,
        focuser: SimFocuser | None = None,
        best_focus_position: int = BEST_FOCUS_POSITION,
    ) -> None:
        self._clock = clock or SystemClock()
        self._mount = mount
        # Without a focuser the field is rendered sharp, as it always was.
        self._focuser = focuser
        self._best_focus = best_focus_position
        self._width = width_px
        self._height = height_px
        self._connected = False
        self._exposure_start: float | None = None
        self._exposure_milliseconds = 0.0
        self._gain = 0
        self._blank_frames = 0
        self._saturated_frames = 0
        self._star_transmission = 1.0
        self._sky_glow = 1.0
        self._disc: SimDisc | None = None
        self.frames_read = 0

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.simulated

    # -- faults on demand (ADR-080) -------------------------------------

    def blank_frames(self, count: int) -> None:
        """The next `count` frames are flat: a capped lens or a dead sensor."""
        self._blank_frames = count

    def saturate_frames(self, count: int) -> None:
        """The next `count` frames are clipped white."""
        self._saturated_frames = count

    def set_clouds(self, star_transmission: float, sky_glow: float) -> None:
        """Cloud until `clear_clouds`: starlight dimmed, the sky lit from below."""
        self._star_transmission = star_transmission
        self._sky_glow = sky_glow

    def clear_clouds(self) -> None:
        self._star_transmission = 1.0
        self._sky_glow = 1.0

    def show_disc(
        self,
        altitude_degrees: float,
        azimuth_degrees: float,
        radius_px: float = 120.0,
        brightness: float = 5_000_000.0,
        degrees_per_pixel: float | None = None,
    ) -> None:
        """A Moon or planet at a fixed sky position.

        The scale defaults to the f/10 train on this sensor's height, which is what
        the runner converts a centroid offset with; a test that passes its own is
        testing a camera the runner has been told nothing about.
        """
        if degrees_per_pixel is None:
            from darkview_agent.runtime import field_height_degrees

            degrees_per_pixel = field_height_degrees(OpticalConfig.f10_native) / self._height
        self._disc = SimDisc(
            altitude_degrees, azimuth_degrees, radius_px, brightness, degrees_per_pixel
        )

    def move_disc(self, altitude_degrees: float = 0.0, azimuth_degrees: float = 0.0) -> None:
        """The disc moves against the stars it is tracked at."""
        assert self._disc is not None
        self._disc.altitude_degrees += altitude_degrees
        self._disc.azimuth_degrees += azimuth_degrees

    def hide_disc(self) -> None:
        self._disc = None

    def disc_offset_px(self) -> tuple[float, float] | None:
        """Where the disc would land relative to the frame centre, now."""
        if self._disc is None or self._mount is None:
            return None
        status = self._mount.status()
        disc = self._disc
        dx = (
            (disc.azimuth_degrees - status.azimuth_degrees)
            * math.cos(math.radians(status.altitude_degrees))
            / disc.degrees_per_pixel
        )
        dy = (status.altitude_degrees - disc.altitude_degrees) / disc.degrees_per_pixel
        return dx, dy

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self.abort_exposure()
        self._connected = False

    def status(self) -> CameraStatus:
        return CameraStatus(
            connected=self._connected,
            exposing=self._exposure_start is not None and not self.exposure_complete(),
            width_px=self._width,
            height_px=self._height,
            health=DeviceHealth.ok if self._connected else DeviceHealth.disconnected,
            mode=self.mode,
        )

    def expose(self, exposure_milliseconds: float, gain: int) -> None:
        if not self._connected:
            raise NotConnectedError("camera is not connected")
        if exposure_milliseconds <= 0:
            raise ValueError("exposureMilliseconds must be greater than zero")
        if gain < 0:
            raise ValueError("gain must not be negative")

        self._exposure_milliseconds = exposure_milliseconds
        self._gain = gain
        self._exposure_start = self._clock.monotonic()

    def exposure_complete(self) -> bool:
        if self._exposure_start is None:
            return False
        elapsed = self._clock.monotonic() - self._exposure_start
        return elapsed >= self._exposure_milliseconds / 1000.0

    def abort_exposure(self) -> None:
        self._exposure_start = None

    def read_frame(self) -> Frame:
        if self._exposure_start is None:
            raise ValueError("no exposure has been started")
        if not self.exposure_complete():
            raise ValueError("exposure is still running")

        altitude, azimuth = (0.0, 0.0)
        if self._mount is not None:
            mount_status = self._mount.status()
            altitude = mount_status.altitude_degrees
            azimuth = mount_status.azimuth_degrees

        pixels = starfield.render(
            width_px=self._width,
            height_px=self._height,
            altitude_degrees=altitude,
            azimuth_degrees=azimuth,
            exposure_milliseconds=self._exposure_milliseconds,
            gain=self._gain,
            defocus_px=(
                0.0
                if self._focuser is None
                else abs(self._focuser.optical_position - self._best_focus)
                / self.STEPS_PER_PIXEL_OF_BLUR
            ),
            star_transmission=self._star_transmission,
            sky_glow=self._sky_glow,
        )
        pixels = self._spoil(self._draw_disc(pixels))
        self._exposure_start = None
        self.frames_read += 1

        return Frame(
            pixels=pixels,
            exposure_milliseconds=self._exposure_milliseconds,
            gain=self._gain,
            captured_at=datetime.now(UTC),
            mode=self.mode,
        )


    def _draw_disc(self, pixels: np.ndarray) -> np.ndarray:
        offset = self.disc_offset_px()
        if offset is None:
            return pixels
        assert self._disc is not None
        cx = (self._width - 1) / 2.0 + offset[0]
        cy = (self._height - 1) / 2.0 + offset[1]
        y_grid, x_grid = np.ogrid[0 : self._height, 0 : self._width]
        inside = (x_grid - cx) ** 2 + (y_grid - cy) ** 2 <= self._disc.radius_px**2
        level = (
            self._disc.brightness
            * self._exposure_milliseconds
            / 1000.0
            * (1.0 + self._gain / 100.0)
            * self._star_transmission
        )
        out = pixels.astype(np.float64)
        out[inside] += level
        return np.clip(out, 0, starfield.FULL_WELL).astype(np.uint16)

    def _spoil(self, pixels: np.ndarray) -> np.ndarray:
        if self._blank_frames > 0:
            self._blank_frames -= 1
            rng = np.random.default_rng(self.frames_read)
            return np.clip(rng.normal(200.0, 4.0, pixels.shape), 0, None).astype(np.uint16)
        if self._saturated_frames > 0:
            self._saturated_frames -= 1
            return np.full(pixels.shape, starfield.FULL_WELL, dtype=np.uint16)
        return pixels


class SimFocuser(FocuserDriver):
    """A simulated focus motor, with travel time and backlash.

    Backlash is modelled because it is real and it matters: an autofocus routine
    that ignores direction change converges to the wrong position on hardware.
    The reported position is the motor's. `optical_position` is where the optics
    actually are: after a reversal the motor turns through the slack before the
    drawtube moves, so the two differ by the backlash until the direction reverses
    again. Only the simulated camera reads it -- a real focuser cannot report it,
    which is the whole problem.
    """

    MAX_POSITION = 30000
    STEPS_PER_SECOND = 900.0
    BACKLASH_STEPS = 45

    def __init__(
        self,
        clock: Clock | None = None,
        position: int = 15000,
        backlash_steps: int = BACKLASH_STEPS,
    ) -> None:
        self._clock = clock or SystemClock()
        self._connected = False
        self._backlash = backlash_steps
        #: Motor position minus optical position once the move has finished.
        self._slack = 0
        self._position = position
        self._target = position
        self._move_start: float | None = None
        self._move_duration = 0.0
        self._move_from = position
        self._last_direction = 0

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.simulated

    def connect(self) -> None:
        self._connected = True

    def disconnect(self) -> None:
        self.halt()
        self._connected = False

    def _settle(self) -> None:
        if self._move_start is None:
            return
        elapsed = self._clock.monotonic() - self._move_start
        if elapsed >= self._move_duration:
            self._position = self._target
            self._move_start = None
            return
        fraction = 0.0 if self._move_duration == 0 else elapsed / self._move_duration
        self._position = int(self._move_from + (self._target - self._move_from) * fraction)

    @property
    def optical_position(self) -> int:
        """Where the optics are. Settled moves only; the simulated camera reads this."""
        self._settle()
        return self._position - self._slack

    def status(self) -> FocuserStatus:
        self._settle()
        return FocuserStatus(
            connected=self._connected,
            moving=self._move_start is not None,
            position=self._position,
            max_position=self.MAX_POSITION,
            health=DeviceHealth.ok if self._connected else DeviceHealth.disconnected,
            mode=self.mode,
        )

    def move_to(self, position: int) -> None:
        if not self._connected:
            raise NotConnectedError("focuser is not connected")
        if not 0 <= position <= self.MAX_POSITION:
            raise ValueError(f"position must be within 0..{self.MAX_POSITION}")

        self._settle()
        direction = 1 if position > self._position else -1 if position < self._position else 0
        distance = abs(position - self._position)

        # Reversing direction eats the backlash before the optics move.
        if direction != 0 and self._last_direction != 0 and direction != self._last_direction:
            distance += self.BACKLASH_STEPS
        # Play of width `backlash`: the optics sit between `motor - backlash` and
        # `motor`, and only move when the motor pushes them past an end. Moving
        # outward leaves them `backlash` behind; moving inward leaves them level.
        optical = self._position - self._slack
        optical = max(position - self._backlash, min(optical, position))
        self._slack = position - optical

        self._move_from = self._position
        self._target = position
        self._move_duration = distance / self.STEPS_PER_SECOND
        self._move_start = self._clock.monotonic()
        if direction != 0:
            self._last_direction = direction

    def halt(self) -> None:
        self._settle()
        self._move_start = None
        self._target = self._position
