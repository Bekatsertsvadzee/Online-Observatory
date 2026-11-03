"""`NexStarFocuser` -- the Celestron focus motor on the AUX bus, device 0x12 (ADR-076).

Reached through the hand controller's passthrough on the same serial port as
`NexStarMount`. The panel in `~/telescope` drives it with position (0x01) and
GOTO (0x02); this adds the travel limits (0x2C) and the move-done flag (0x13),
which the panel does not use and nothing here has run against the motor.

Positions are reported from the motor's lower limit, so `0..max_position` is the
travel the motor's own calibration found. An uncalibrated motor reports no usable
limits, and `connect` refuses it.
"""

from __future__ import annotations

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.devices.base import (
    DeviceError,
    FocuserDriver,
    FocuserStatus,
    NotConnectedError,
)
from darkview_agent.devices.nexstar import NexStarLink

FOCUSER = 0x12
GET_POSITION = 0x01
GOTO_FAST = 0x02
MOVE_POSITIVE = 0x24
SLEW_DONE = 0x13
GET_LIMITS = 0x2C
GET_VERSION = 0xFE


class NexStarFocuser(FocuserDriver):
    def __init__(self, link: NexStarLink) -> None:
        self._link = link
        self._connected = False
        self._low = 0
        self._high = 0
        self._last_position = 0

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.real

    def _raw_position(self) -> int:
        reply = self._link.passthrough(FOCUSER, GET_POSITION, b"", 3)
        return reply[0] << 16 | reply[1] << 8 | reply[2]

    def connect(self) -> None:
        if self._connected:
            return
        self._link.open()
        try:
            self._link.passthrough(FOCUSER, GET_VERSION, b"", 2)
            limits = self._link.passthrough(FOCUSER, GET_LIMITS, b"", 8)
            low = int.from_bytes(limits[0:4], "big", signed=True)
            high = int.from_bytes(limits[4:8], "big", signed=True)
            if high <= low:
                raise DeviceError(
                    f"the focus motor reports limits {low}..{high}; calibrate it from the "
                    "hand controller first"
                )
        except DeviceError:
            self._link.close()
            raise
        self._low, self._high = low, high
        self._connected = True

    def disconnect(self) -> None:
        if not self._connected:
            return
        try:
            self.halt()
        finally:
            self._link.close()
            self._connected = False

    def status(self) -> FocuserStatus:
        if not self._connected:
            return FocuserStatus(
                connected=False,
                moving=False,
                position=self._last_position,
                max_position=self._high - self._low,
                health=DeviceHealth.disconnected,
                mode=self.mode,
            )
        done = self._link.passthrough(FOCUSER, SLEW_DONE, b"", 1)[0] == 0xFF
        self._last_position = self._raw_position() - self._low
        return FocuserStatus(
            connected=True,
            moving=not done,
            position=self._last_position,
            max_position=self._high - self._low,
            health=DeviceHealth.ok,
            mode=self.mode,
        )

    def move_to(self, position: int) -> None:
        if not self._connected:
            raise NotConnectedError("focuser is not connected")
        if not 0 <= position <= self._high - self._low:
            raise ValueError(f"position must be within 0..{self._high - self._low}")
        raw = self._low + position
        self._link.passthrough(FOCUSER, GOTO_FAST, raw.to_bytes(3, "big"), 0)

    def halt(self) -> None:
        if not self._connected:
            return
        self._link.passthrough(FOCUSER, MOVE_POSITIVE, b"\x00", 0)
