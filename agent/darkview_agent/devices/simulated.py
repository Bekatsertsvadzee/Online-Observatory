"""Simulated devices — the default implementation, always.

These model timing rather than consuming it. A slew has a duration derived from
angular distance and slew rate; progress is computed from the clock each time
status is read. Nothing sleeps, so a test can drive a 90-degree slew, abort it
halfway, and assert the mount stopped where it actually was.

Every status and every frame these produce carries ObservatoryMode.simulated.
"""

from __future__ import annotations

from datetime import UTC, datetime

from contracts.models import DeviceHealth, ObservatoryMode
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

# NexStar 6SE plausible values. DV-034 replaces these with figures measured from
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
        """
        self.abort_slew()
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


class SimCamera(CameraDriver):
    """A simulated ASI585MC.

    Renders the star field for wherever the mount is pointing, so a frame is
    evidence of where the telescope actually is.
    """

    DEFAULT_WIDTH_PX = 1920
    DEFAULT_HEIGHT_PX = 1080

    def __init__(
        self,
        clock: Clock | None = None,
        mount: SimMount | None = None,
        width_px: int = DEFAULT_WIDTH_PX,
        height_px: int = DEFAULT_HEIGHT_PX,
    ) -> None:
        self._clock = clock or SystemClock()
        self._mount = mount
        self._width = width_px
        self._height = height_px
        self._connected = False
        self._exposure_start: float | None = None
        self._exposure_milliseconds = 0.0
        self._gain = 0

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.simulated

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
        )
        self._exposure_start = None

        return Frame(
            pixels=pixels,
            exposure_milliseconds=self._exposure_milliseconds,
            gain=self._gain,
            captured_at=datetime.now(UTC),
            mode=self.mode,
        )


class SimFocuser(FocuserDriver):
    """A simulated focus motor, with travel time and backlash.

    Backlash is modelled because it is real and it matters: an autofocus routine
    that ignores direction change converges to the wrong position on hardware.
    DV-031 needs somewhere to prove it handles that before the motor arrives.
    """

    MAX_POSITION = 30000
    STEPS_PER_SECOND = 900.0
    BACKLASH_STEPS = 45

    def __init__(self, clock: Clock | None = None, position: int = 15000) -> None:
        self._clock = clock or SystemClock()
        self._connected = False
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
