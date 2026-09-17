"""An ASCOM Alpaca telescope that answers from memory.

It keeps the ASCOM rules `AlpacaMount` has to live with -- a slew refused while
tracking or parked, reads refused while disconnected, error numbers in a 200 --
and borrows `SimMount` for the motion, so a slew still takes time on a
`ManualClock`. It is a model of the protocol as the ASCOM specification states it,
not of the Celestron driver, which nothing here has seen.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qsl

from darkview_agent.clock import ManualClock
from darkview_agent.devices.alpaca import AlpacaMount
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.simulated import SimMount

NOT_IMPLEMENTED = 0x400
INVALID_VALUE = 0x401
NOT_CONNECTED = 0x407
INVALID_WHILE_PARKED = 0x408
INVALID_OPERATION = 0x40B


class AlpacaRefusal(Exception):
    def __init__(self, number: int, message: str) -> None:
        super().__init__(message)
        self.number = number


class FakeAlpacaTelescope:
    def __init__(self, clock: ManualClock | None = None) -> None:
        self.clock = clock or ManualClock()
        self.mount = SimMount(clock=self.clock)
        self.connected = False
        self.capabilities = {
            "canslewaltazasync": True,
            "canpark": True,
            "canunpark": True,
            "cansettracking": True,
        }
        #: (method, member, parameters without the client ids), in order.
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.unreachable = False
        self.fail_members: dict[str, tuple[int, str]] = {}

    def puts(self, member: str) -> list[dict[str, str]]:
        return [
            params for method, name, params in self.requests if method == "PUT" and name == member
        ]

    # The transport AlpacaMount calls.
    def transport(
        self, method: str, path: str, params: dict[str, str], timeout: float
    ) -> tuple[int, bytes]:
        if self.unreachable:
            raise DeviceError("Alpaca bridge at 127.0.0.1:11111 did not answer: refused")
        prefix = "/api/v1/telescope/0/"
        if not path.startswith(prefix):
            return 400, b"unknown device"
        member = path[len(prefix) :]
        return self.handle(method, member, params)

    def handle(self, method: str, member: str, params: dict[str, str]) -> tuple[int, bytes]:
        if "ClientID" not in params or "ClientTransactionID" not in params:
            return 400, b"missing client ids"
        visible = {k: v for k, v in params.items() if k not in ("ClientID", "ClientTransactionID")}
        self.requests.append((method, member, visible))

        answer: dict = {"ErrorNumber": 0, "ErrorMessage": ""}
        try:
            if member in self.fail_members:
                raise AlpacaRefusal(*self.fail_members[member])
            value = self._get(member) if method == "GET" else self._put(member, visible)
            if value is not None:
                answer["Value"] = value
        except AlpacaRefusal as refusal:
            answer = {"ErrorNumber": refusal.number, "ErrorMessage": str(refusal)}
        except KeyError:
            return 400, f"missing parameter for {member}".encode()
        return 200, json.dumps(answer).encode()

    def _require_connected(self) -> None:
        if not self.connected:
            raise AlpacaRefusal(NOT_CONNECTED, "not connected")

    def _get(self, member: str):
        if member == "connected":
            return self.connected
        if member in self.capabilities:
            return self.capabilities[member]
        self._require_connected()
        status = self.mount.status()
        values = {
            "slewing": status.slewing,
            "tracking": status.tracking,
            "atpark": status.parked,
            "altitude": status.altitude_degrees,
            "azimuth": status.azimuth_degrees,
        }
        if member not in values:
            raise AlpacaRefusal(NOT_IMPLEMENTED, f"{member} is not implemented")
        return values[member]

    def _put(self, member: str, params: dict[str, str]):
        if member == "connected":
            self.connected = _boolean(params["Connected"])
            if self.connected:
                self.mount.connect()
            return None
        self._require_connected()
        status = self.mount.status()

        if member == "tracking":
            tracking = _boolean(params["Tracking"])
            if tracking and status.parked:
                raise AlpacaRefusal(INVALID_WHILE_PARKED, "parked")
            self.mount.set_tracking(tracking)
        elif member == "slewtoaltazasync":
            altitude, azimuth = float(params["Altitude"]), float(params["Azimuth"])
            if status.parked:
                raise AlpacaRefusal(INVALID_WHILE_PARKED, "parked")
            if status.tracking:
                raise AlpacaRefusal(INVALID_OPERATION, "SlewToAltAz is invalid while tracking")
            if not (0.0 <= azimuth < 360.0 and -90.0 <= altitude <= 90.0):
                raise AlpacaRefusal(INVALID_VALUE, "coordinates out of range")
            self.mount.slew_to(altitude, azimuth)
        elif member == "abortslew":
            if status.parked:
                raise AlpacaRefusal(INVALID_WHILE_PARKED, "parked")
            self.mount.abort_slew()
        elif member == "park":
            self.mount.park()
        elif member == "unpark":
            self.mount.unpark()
        else:
            raise AlpacaRefusal(NOT_IMPLEMENTED, f"{member} is not implemented")
        return None


def parse_form(body: bytes) -> dict[str, str]:
    return dict(parse_qsl(body.decode("utf-8"), keep_blank_values=True))


def _boolean(raw: str) -> bool:
    if raw not in ("True", "False"):
        raise AlpacaRefusal(INVALID_VALUE, f"{raw!r} is not True or False")
    return raw == "True"


def alpaca_mount(telescope: FakeAlpacaTelescope) -> AlpacaMount:
    return AlpacaMount("127.0.0.1", 11111, transport=telescope.transport)
