"""`NexStarMount` -- the mount over the NexStar hand controller's serial port (ADR-076).

The 8SE's hand controller speaks Celestron's NexStar serial protocol and nothing
else. On Windows the ASCOM driver translates it into Alpaca (`AlpacaMount`); on the
dedicated Mac there is no ASCOM, so this driver speaks the protocol itself through
the PL2303 USB-serial cable, 9600 baud 8N1. Nothing listens: a serial port is a
device file, not a socket, so `docs/ENGINEERING.md`'s one-listener rule is untouched.

Ported from the operator's own panel (`~/telescope`, observatory.py and panel.py),
using only the commands that panel already drives the mount with:

- `z`: both axis positions, 32-bit fractions of a turn, `AAAAAAAA,BBBBBBBB#`.
- `P,3,{16|17},{6|7},hi,lo,0,0`: one axis at a variable rate, in quarter
  arc-seconds per second (6 positive, 7 negative). The reply is `#`.

**The hand controller is not aligned and does not track.** Its axes are raw motor
positions. A pointing model -- the panel's: mount = sign * sky + offset per axis,
fitted to sync points -- turns sky altitude and azimuth into axis positions and
back. The agent has no sync command, so the model is read from a file the
operator wrote by syncing in the panel (`observatory.json` there; its `points`,
`sign` and `park` keys). No points, no model, and `connect` refuses.

**GoTo and tracking are a control loop here**, not a hand controller command: four
times a second the driver reads the axes and commands each axis's rate, a
proportional term towards the aim plus, while tracking, the sky's own motion fed
forward. A thread runs it; `tick()` is the step, and tests call it on a fake clock.

Guards this driver keeps, because the hand controller keeps none of them:

- **Runaway.** A slew or park whose error grows by more than a degree over three
  seconds is stopped and the mount reports a fault (the panel's guard: a wrong
  model sign drives the tube away from the target forever).
- **A stopped loop.** Rates persist on the hand controller until replaced. A loop
  that has not ticked for two seconds while the mount moves makes `status()` raise.
- **Every exit halts.** `disconnect`, `abort_slew`, a fault and a serial error all
  command both rates to zero.
- **Tracking stops at the horizon.** A tracked direction that sets is not followed
  into the ground.

Policy -- the Sun, MAX_ALT_SAFE, the horizon mask -- is still not checked here.
Nothing reaches a driver without passing the safety envelope first.

**Unverified on the hardware**, and DV-034's to confirm: the arrival thresholds,
the gain, the park position, and that the 8SE's hand controller accepts `P,3` at
the 4 degree per second ceiling.
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Protocol

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.clock import Clock, SystemClock
from darkview_agent.devices.base import (
    DeviceError,
    MountDriver,
    MountStatus,
    NotConnectedError,
)
from darkview_agent.safety.coordinates import equatorial_to_horizontal, horizontal_to_equatorial
from darkview_agent.safety.sun import SiteLocation

logger = logging.getLogger("darkview.agent.nexstar")

BAUD = 9600
READ_TIMEOUT_SECONDS = 1.0

#: The two motor controllers on the AUX bus, as the hand controller passes them through.
AZIMUTH_AXIS = 16
ALTITUDE_AXIS = 17

#: The control loop's period, its gain, and the fastest it will ever drive an axis.
TICK_SECONDS = 0.25
GAIN_PER_SECOND = 1.2
MAX_RATE_DEGREES_PER_SECOND = 4.0

#: Arrived: within this of the aim on both axes, or within the looser figure for
#: three seconds running (a real mount may hover rather than land).
ARRIVED_DEGREES = 0.005
SETTLED_DEGREES = 0.03
SETTLED_TICKS = 12

#: Runaway: the error is more than this above where it was three seconds ago.
RUNAWAY_DEGREES = 1.0
RUNAWAY_TICKS = 12

#: A moving mount whose loop has not run for this long is a fault.
STALLED_SECONDS = 2.0

#: Park when the model file names no park position: tube near level, at the
#: current azimuth -- the panel's default.
PARK_SKY_ALTITUDE_DEGREES = 2.0
PARK_TIMEOUT_SECONDS = 180.0


class SerialPort(Protocol):
    def write(self, data: bytes) -> object: ...

    def read(self, size: int) -> bytes: ...

    def reset_input_buffer(self) -> None: ...

    def close(self) -> None: ...


def pyserial_port(path: str) -> Callable[[], SerialPort]:
    """The real port. pyserial is imported only when the port is opened."""

    def open_port() -> SerialPort:
        import serial  # the hardware extra

        try:
            return serial.Serial(path, BAUD, timeout=READ_TIMEOUT_SECONDS)
        except (OSError, serial.SerialException) as error:
            raise DeviceError(f"could not open the hand controller port {path}: {error}") from None

    return open_port


class NexStarLink:
    """The one serial port, shared by the mount and the AUX focuser behind it."""

    def __init__(self, open_port: Callable[[], SerialPort]) -> None:
        self._open_port = open_port
        self._port: SerialPort | None = None
        self._users = 0
        self._lock = threading.RLock()

    def open(self) -> None:
        with self._lock:
            if self._port is None:
                self._port = self._open_port()
            self._users += 1

    def close(self) -> None:
        with self._lock:
            self._users = max(0, self._users - 1)
            if self._users == 0 and self._port is not None:
                port, self._port = self._port, None
                port.close()

    def command(self, data: bytes, reply_length: int = 1) -> bytes:
        """Send one command, return its reply without the closing `#`."""
        with self._lock:
            if self._port is None:
                raise NotConnectedError("the hand controller port is not open")
            try:
                self._port.reset_input_buffer()
                self._port.write(data)
                reply = self._port.read(reply_length)
            except OSError as error:
                raise DeviceError(f"hand controller serial error: {error}") from None
        if len(reply) != reply_length or reply[-1:] != b"#":
            raise DeviceError(
                f"hand controller answered {len(reply)} of {reply_length} bytes to "
                f"0x{data[:1].hex()} (cable, power, or another program on the port)"
            )
        return reply[:-1]

    def passthrough(self, device: int, command: int, payload: bytes, reply_length: int) -> bytes:
        """An AUX command passed through: `P`, length, device, command, 3 bytes, reply length."""
        body = payload.ljust(3, b"\x00")
        frame = bytes([80, len(payload) + 1, device, command, *body, reply_length])
        return self.command(frame, reply_length + 1)


def wrap180(degrees: float) -> float:
    return (degrees + 180.0) % 360.0 - 180.0


@dataclass(frozen=True)
class SyncPoint:
    mount_azimuth: float
    mount_altitude: float
    azimuth: float
    altitude: float


class PointingModel:
    """mount = sign * sky + offset, per axis, fitted to sync points (the panel's model).

    An axis's sign flips only with wide sky coverage and a fit three times better,
    so two nearby points cannot reverse a motor.
    """

    def __init__(self, points: list[SyncPoint], sign: dict[str, int] | None = None) -> None:
        if not points:
            raise ValueError("a pointing model needs at least one sync point")
        self.points = points
        sign = dict(sign or {"az": 1, "alt": 1})
        if len(points) >= 3:
            az_spread = max(abs(wrap180(p.azimuth - q.azimuth)) for p in points for q in points)
            alt_spread = max(p.altitude for p in points) - min(p.altitude for p in points)
            for axis, spread, need in (("az", az_spread, 30.0), ("alt", alt_spread, 15.0)):
                flipped = {**sign, axis: -sign[axis]}
                if spread > need and self._fit(flipped)[2] < self._fit(sign)[2] / 3:
                    sign = flipped
        self.sign = sign
        self.azimuth_offset, self.altitude_offset, self.residual_degrees = self._fit(sign)

    def _fit(self, sign: dict[str, int]) -> tuple[float, float, float]:
        points = self.points
        differences = [math.radians(p.mount_azimuth - sign["az"] * p.azimuth) for p in points]
        azimuth_offset = math.degrees(
            math.atan2(sum(map(math.sin, differences)), sum(map(math.cos, differences)))
        )
        altitude_offset = sum(p.mount_altitude - sign["alt"] * p.altitude for p in points) / len(
            points
        )
        residual = max(
            math.hypot(
                wrap180(p.mount_azimuth - sign["az"] * p.azimuth - azimuth_offset)
                * math.cos(math.radians(p.altitude)),
                p.mount_altitude - sign["alt"] * p.altitude - altitude_offset,
            )
            for p in points
        )
        return azimuth_offset, altitude_offset, residual

    def sky_to_mount(self, altitude: float, azimuth: float) -> tuple[float, float]:
        """(mount azimuth, mount altitude) for a sky direction."""
        return (
            (self.sign["az"] * azimuth + self.azimuth_offset) % 360.0,
            self.sign["alt"] * altitude + self.altitude_offset,
        )

    def mount_to_sky(self, mount_azimuth: float, mount_altitude: float) -> tuple[float, float]:
        """(sky altitude, sky azimuth) for axis positions."""
        return (
            (mount_altitude - self.altitude_offset) * self.sign["alt"],
            ((mount_azimuth - self.azimuth_offset) * self.sign["az"]) % 360.0,
        )


@dataclass(frozen=True)
class ModelFile:
    model: PointingModel
    park: tuple[float, float] | None
    """Mount axes (azimuth, altitude), or None for the default."""


def load_model_file(path: Path) -> ModelFile:
    """The panel's `observatory.json` shape: `points`, optional `sign` and `park`."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        points = [
            SyncPoint(float(p["maz"]), float(p["malt"]), float(p["az"]), float(p["alt"]))
            for p in raw.get("points", [])
            if "maz" in p
        ]
        sign = raw.get("sign")
        if sign is not None:
            sign = {"az": 1 if sign["az"] >= 0 else -1, "alt": 1 if sign["alt"] >= 0 else -1}
        park = raw.get("park")
        park = (float(park[0]), float(park[1])) if park else None
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        raise DeviceError(f"the pointing model {path} is not readable: {error}") from None
    if not points:
        raise DeviceError(
            f"the pointing model {path} has no sync points. Centre a star in the panel and "
            "Sync at least once; the agent cannot point an unaligned mount."
        )
    return ModelFile(PointingModel(points, sign), park)


class Motion(StrEnum):
    IDLE = "IDLE"
    SLEWING = "SLEWING"
    TRACKING = "TRACKING"
    PARKING = "PARKING"
    PARKED = "PARKED"


class NexStarMount(MountDriver):
    def __init__(
        self,
        link: NexStarLink,
        model_path: Path,
        site: SiteLocation,
        *,
        clock: Clock | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], None] = time.sleep,
        run_loop: bool = True,
    ) -> None:
        self._link = link
        self._model_path = model_path
        self._site = site
        self._clock = clock or SystemClock()
        self._now = now
        self._sleep = sleep
        self._run_loop = run_loop
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

        self._connected = False
        self._model: PointingModel | None = None
        self._park: tuple[float, float] | None = None
        self._motion = Motion.IDLE
        self._tracking = False
        self._aim: tuple[float, float] | None = None
        """A slew's sky (altitude, azimuth), or None."""
        self._park_goal: tuple[float, float] | None = None
        """A park's mount axes (azimuth, altitude), or None."""
        self._tracked: tuple[float, float] | None = None
        """The (RA hours, Dec) being held while tracking."""
        self._errors: deque[float] = deque(maxlen=RUNAWAY_TICKS)
        self._near_ticks = 0
        self._fault: str | None = None
        self._last_tick = 0.0
        self._ticking = False
        self._last_axes: tuple[float, float] = (0.0, 0.0)

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.real

    # ------------------------------------------------------------------
    # The wire
    # ------------------------------------------------------------------

    def _read_axes(self) -> tuple[float, float]:
        reply = self._link.command(b"z", 18)
        try:
            azimuth = int(reply[0:8], 16) / 2**32 * 360.0
            altitude = int(reply[9:17], 16) / 2**32 * 360.0
        except ValueError:
            raise DeviceError(
                f"hand controller position reply is not hexadecimal: {reply!r}"
            ) from None
        self._last_axes = (azimuth, wrap180(altitude))
        return self._last_axes

    def _rate(self, axis: int, degrees_per_second: float) -> None:
        value = min(int(abs(degrees_per_second) * 3600 * 4), 65535)
        direction = 6 if degrees_per_second >= 0 else 7
        self._link.command(bytes([80, 3, axis, direction, value >> 8, value & 255, 0, 0]))

    def _halt(self) -> None:
        self._rate(AZIMUTH_AXIS, 0.0)
        self._rate(ALTITUDE_AXIS, 0.0)

    def _halt_quietly(self) -> None:
        try:
            self._halt()
        except DeviceError as error:
            logger.error("could not halt the mount: %s", error)

    # ------------------------------------------------------------------
    # MountDriver
    # ------------------------------------------------------------------

    def connect(self) -> None:
        with self._lock:
            if self._connected:
                return
            model = load_model_file(self._model_path)
            self._link.open()
            try:
                self._read_axes()
                self._halt()
            except DeviceError:
                self._link.close()
                raise
            self._model, self._park = model.model, model.park
            self._connected = True
            self._fault = None
            self._last_tick = self._clock.monotonic()
            logger.info(
                "NexStar mount connected: %d sync point(s), residual %.2f deg",
                len(model.model.points),
                model.model.residual_degrees,
            )
        if self._run_loop:
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="nexstar-mount", daemon=True)
            self._thread.start()

    def disconnect(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        with self._lock:
            if not self._connected:
                return
            try:
                self._halt()
            finally:
                self._link.close()
                self._connected = False
                self._tracking = False
                if self._motion is not Motion.PARKED:
                    self._motion = Motion.IDLE

    def status(self) -> MountStatus:
        with self._lock:
            if not self._connected:
                altitude, azimuth = (
                    self._model.mount_to_sky(*self._last_axes) if self._model else (0.0, 0.0)
                )
                return MountStatus(
                    connected=False,
                    slewing=False,
                    tracking=False,
                    parked=self._motion is Motion.PARKED,
                    altitude_degrees=altitude,
                    azimuth_degrees=azimuth,
                    health=DeviceHealth.disconnected,
                    mode=self.mode,
                )
            axes = self._read_axes() if not self._fault else self._last_axes
            if self._fault:
                raise DeviceError(self._fault)
            moving = self._motion in (Motion.SLEWING, Motion.TRACKING, Motion.PARKING)
            if moving and self._clock.monotonic() - self._last_tick > STALLED_SECONDS:
                self._fail("the mount's control loop stopped while the mount was moving")
                raise DeviceError(self._fault)
            altitude, azimuth = self._model.mount_to_sky(*axes)
            return MountStatus(
                connected=True,
                slewing=self._motion in (Motion.SLEWING, Motion.PARKING),
                tracking=self._tracking and self._motion is not Motion.PARKED,
                parked=self._motion is Motion.PARKED,
                altitude_degrees=altitude,
                azimuth_degrees=azimuth % 360.0,
                health=DeviceHealth.ok,
                mode=self.mode,
            )

    def slew_to(self, altitude_degrees: float, azimuth_degrees: float) -> None:
        with self._lock:
            self._require_connection()
            self._aim = (float(altitude_degrees), float(azimuth_degrees) % 360.0)
            self._begin(Motion.SLEWING)

    def abort_slew(self) -> None:
        with self._lock:
            if not self._connected:
                return
            if self._motion in (Motion.SLEWING, Motion.PARKING):
                self._motion = Motion.IDLE
                self._tracking = False
                self._halt()

    def park(self) -> None:
        """Connects if it has to, and returns once parked.

        Any motion and any fault is dropped first: park is the recovery action, and
        a mount that ran away is exactly the one to park.
        """
        if not self._connected:
            self.connect()
        with self._lock:
            self._fault = None
            self._tracking = False
            self._park_goal = self._park_target()
            self._begin(Motion.PARKING)
        deadline = self._clock.monotonic() + PARK_TIMEOUT_SECONDS
        while True:
            self.tick()
            with self._lock:
                if self._motion is Motion.PARKED:
                    return
                if self._fault:
                    raise DeviceError(f"park failed: {self._fault}")
                if self._motion is not Motion.PARKING:
                    raise DeviceError("park was interrupted")
            if self._clock.monotonic() > deadline:
                with self._lock:
                    self._fail(f"park did not finish within {PARK_TIMEOUT_SECONDS:.0f}s")
                raise DeviceError(self._fault)
            self._sleep(TICK_SECONDS)

    def unpark(self) -> None:
        with self._lock:
            self._require_connection()
            if self._motion is Motion.PARKED:
                self._motion = Motion.IDLE

    def set_tracking(self, tracking: bool) -> None:
        with self._lock:
            self._require_connection()
            if not tracking:
                self._tracking = False
                if self._motion is Motion.TRACKING:
                    self._motion = Motion.IDLE
                    self._halt()
                return
            if self._motion is Motion.PARKED:
                raise NotConnectedError("cannot track while parked")
            self._tracking = True
            if self._motion is Motion.IDLE:
                altitude, azimuth = self._model.mount_to_sky(*self._read_axes())
                self._start_tracking(altitude, azimuth)

    # ------------------------------------------------------------------
    # The control loop
    # ------------------------------------------------------------------

    def _require_connection(self) -> None:
        if not self._connected:
            raise NotConnectedError("mount is not connected")

    def _begin(self, motion: Motion) -> None:
        self._motion = motion
        self._errors.clear()
        self._near_ticks = 0
        self._last_tick = self._clock.monotonic()

    def _start_tracking(self, altitude: float, azimuth: float) -> None:
        self._tracked = horizontal_to_equatorial(altitude, azimuth, self._now(), self._site)
        self._begin(Motion.TRACKING)

    def _park_target(self) -> tuple[float, float]:
        if self._park is not None:
            return self._park
        mount_azimuth = self._read_axes()[0]
        return mount_azimuth, self._model.sky_to_mount(PARK_SKY_ALTITUDE_DEGREES, 0.0)[1]

    def _fail(self, reason: str) -> None:
        logger.error("NexStar mount fault: %s", reason)
        self._fault = reason
        self._motion = Motion.IDLE
        self._tracking = False
        self._halt_quietly()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(TICK_SECONDS)

    def tick(self) -> None:
        """One control step. The thread calls this four times a second."""
        with self._lock:
            if self._ticking or not self._connected or self._fault:
                return
            self._last_tick = self._clock.monotonic()
            if self._motion in (Motion.IDLE, Motion.PARKED):
                return
            self._ticking = True
            try:
                self._step()
            except DeviceError as error:
                self._fail(str(error))
            finally:
                self._ticking = False

    def _step(self) -> None:
        mount_azimuth, mount_altitude = self._read_axes()
        feed_azimuth = feed_altitude = 0.0

        if self._motion is Motion.PARKING:
            goal_azimuth, goal_altitude = self._park_goal
            weight = 1.0
        elif self._motion is Motion.SLEWING:
            altitude, azimuth = self._aim
            goal_azimuth, goal_altitude = self._model.sky_to_mount(altitude, azimuth)
            weight = math.cos(math.radians(altitude))
        else:
            moment = self._now()
            here = equatorial_to_horizontal(*self._tracked, moment, self._site)
            if here.altitude_degrees < 0.0:
                logger.warning("tracked direction has set below the horizon; tracking stopped")
                self._tracking = False
                self._motion = Motion.IDLE
                self._halt()
                return
            later = equatorial_to_horizontal(
                *self._tracked, datetime.fromtimestamp(moment.timestamp() + 1.0, UTC), self._site
            )
            goal_azimuth, goal_altitude = self._model.sky_to_mount(
                here.altitude_degrees, here.azimuth_degrees
            )
            feed_azimuth = self._model.sign["az"] * wrap180(
                later.azimuth_degrees - here.azimuth_degrees
            )
            feed_altitude = self._model.sign["alt"] * (
                later.altitude_degrees - here.altitude_degrees
            )
            weight = math.cos(math.radians(here.altitude_degrees))

        error_azimuth = wrap180(goal_azimuth - mount_azimuth)
        error_altitude = goal_altitude - mount_altitude

        if self._motion in (Motion.SLEWING, Motion.PARKING):
            error = math.hypot(error_azimuth * weight, error_altitude)
            if len(self._errors) == RUNAWAY_TICKS and error > self._errors[0] + RUNAWAY_DEGREES:
                self._fail(
                    f"the mount moved away from its aim ({error:.1f} deg off and growing); "
                    "check the pointing model's sync points"
                )
                return
            self._errors.append(error)
            largest = max(abs(error_azimuth), abs(error_altitude))
            self._near_ticks = self._near_ticks + 1 if largest < SETTLED_DEGREES else 0
            if largest < ARRIVED_DEGREES or self._near_ticks >= SETTLED_TICKS:
                self._arrive()
                return

        self._rate(AZIMUTH_AXIS, _clamp(feed_azimuth + GAIN_PER_SECOND * error_azimuth))
        self._rate(ALTITUDE_AXIS, _clamp(feed_altitude + GAIN_PER_SECOND * error_altitude))

    def _arrive(self) -> None:
        self._halt()
        if self._motion is Motion.PARKING:
            self._motion = Motion.PARKED
        elif self._tracking:
            self._start_tracking(*self._aim)
        else:
            self._motion = Motion.IDLE


def _clamp(degrees_per_second: float) -> float:
    return max(-MAX_RATE_DEGREES_PER_SECOND, min(MAX_RATE_DEGREES_PER_SECOND, degrees_per_second))
