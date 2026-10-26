"""`AlpacaFocuser` -- any ASCOM focuser, over Alpaca HTTP (DV-031).

Written against the ASCOM Alpaca Device API v1, Focuser device
(https://ascom-standards.org/api/), and not yet run against any focuser. No
document names the observatory's focus motor, which is the reason this goes
through ASCOM at all: a ZWO EAF, a Celestron focus motor or anything else with an
ASCOM driver is reached the same way, through the same loopback-only ASCOM Remote
bridge as the mount. Nothing here is hardware evidence.

**Absolute focusers only.** The interface moves to a position and reports one, and
a relative-only focuser has no position to report. `connect` refuses one rather
than pretending: an autofocus run on positions the driver does not keep would
converge on numbers that mean nothing.

**Temperature compensation is turned off on connect.** A focuser compensating on
its own moves between the autofocus run's samples, and the curve it fits is then
of a moving target.

**Moves longer than `MaxIncrement`** are made in steps of at most that size. The
next step is commanded the first time `status()` sees the previous one finished,
the way `AlpacaMount` resumes tracking after a slew. For most focusers
`MaxIncrement` equals `MaxStep` and every move is one step.
"""

from __future__ import annotations

import logging

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.devices.alpaca import AlpacaClient, Transport
from darkview_agent.devices.base import (
    DeviceError,
    FocuserDriver,
    FocuserStatus,
    NotConnectedError,
)

logger = logging.getLogger("darkview.agent.alpaca")


class AlpacaFocuser(FocuserDriver):
    def __init__(
        self,
        host: str,
        port: int,
        device_number: int = 0,
        *,
        transport: Transport | None = None,
        client_id: int = 1,
    ) -> None:
        self._alpaca = AlpacaClient(
            host, port, "focuser", device_number, transport=transport, client_id=client_id
        )
        self._connected = False
        self._max_step = 0
        self._max_increment = 0
        self._target: int | None = None
        self._last_position = 0

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.real

    def connect(self) -> None:
        self._alpaca.put("connected", {"Connected": "True"})
        try:
            if self._alpaca.get("absolute") is not True:
                raise DeviceError(
                    "the focuser driver is relative-only (Absolute is False); AlpacaFocuser "
                    "needs an absolute focuser that reports its position"
                )
            max_step = int(self._alpaca.get("maxstep"))
            max_increment = int(self._alpaca.get("maxincrement"))
            if max_step <= 0 or max_increment <= 0:
                raise DeviceError(
                    f"the focuser reports MaxStep {max_step} and MaxIncrement "
                    f"{max_increment}; both must be positive"
                )
            if self._temperature_compensating():
                logger.info("focuser temperature compensation was on; turning it off")
                self._alpaca.put("tempcomp", {"TempComp": "False"})
        except DeviceError:
            try:
                self._alpaca.put("connected", {"Connected": "False"})
            except DeviceError as error:
                logger.error("could not release the refused focuser driver: %s", error)
            raise
        self._max_step = max_step
        self._max_increment = max_increment
        self._connected = True

    def _temperature_compensating(self) -> bool:
        # TempComp is optional in ASCOM; a driver without it is not compensating.
        try:
            return self._alpaca.get("tempcomp") is True
        except NotConnectedError:
            raise
        except DeviceError:
            return False

    def disconnect(self) -> None:
        try:
            self.halt()
            self._alpaca.put("connected", {"Connected": "False"})
        finally:
            self._connected = False

    def status(self) -> FocuserStatus:
        if not self._connected:
            return FocuserStatus(
                connected=False,
                moving=False,
                position=self._last_position,
                max_position=self._max_step,
                health=DeviceHealth.disconnected,
                mode=self.mode,
            )

        moving = self._alpaca.get("ismoving") is True
        self._last_position = int(self._alpaca.get("position"))
        if not moving and self._target is not None:
            if self._last_position == self._target:
                self._target = None
            else:
                self._step_towards(self._target)
                moving = True
        return FocuserStatus(
            connected=True,
            moving=moving,
            position=self._last_position,
            max_position=self._max_step,
            health=DeviceHealth.ok,
            mode=self.mode,
        )

    def move_to(self, position: int) -> None:
        if not self._connected:
            raise NotConnectedError("focuser is not connected")
        if not 0 <= position <= self._max_step:
            raise ValueError(f"position must be within 0..{self._max_step}")
        self._last_position = int(self._alpaca.get("position"))
        self._target = position
        self._step_towards(position)

    def _step_towards(self, target: int) -> None:
        distance = max(-self._max_increment, min(self._max_increment, target - self._last_position))
        self._alpaca.put("move", {"Position": str(self._last_position + distance)})

    def halt(self) -> None:
        self._target = None
        if not self._connected:
            return
        self._alpaca.put("halt")
