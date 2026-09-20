"""`AlpacaMount` -- the mount over ASCOM Alpaca HTTP (DV-028).

Written against the ASCOM Alpaca Device API v1, Telescope device
(https://ascom-standards.org/api/), and not yet run against the Celestron driver on
the observatory mini-PC. DV-034 is where that happens. Nothing here is hardware
evidence.

The bridge is reached on a loopback address only. `docs/ENGINEERING.md` allows exactly one
listener at the observatory -- the ASCOM Remote / Alpaca bridge on `127.0.0.1` --
and a driver that accepted any other host would be the first piece of this agent
able to address a device across a network. The host must be a literal loopback
address: a name is resolved by whatever the machine's hosts file says, and that is
not a guarantee.

Every Alpaca call is a request/response against `/api/v1/telescope/{n}/{member}`:
GET with the parameters in the query string, PUT form-encoded in the body. Both
answer with JSON carrying `Value`, `ErrorNumber` and `ErrorMessage`. A non-zero
`ErrorNumber` is a refusal by the driver even when HTTP says 200.

**Alt/az slews and tracking.** The interface slews in altitude and azimuth.
`SlewToAltAzAsync` is refused by an ASCOM driver while `Tracking` is on, and the
mission runner turns tracking on before it slews. So a slew on a tracking mount
turns tracking off, slews, and turns it back on the first time `status()` sees the
motion finished. An abort or a park cancels that; a mount that was stopped stays
stopped.

That is also the answer to the question DV-040 left for this issue: what a nudge
means on a tracking mount. The supervisor sends a nudge as an absolute alt/az slew
to the offset position. Here that moves the axes by the offset at that moment and
then tracks the sky from the new position -- the offset is carried by the target,
not re-applied to the axes as the sky turns. The drift between reading the position
and commanding the step is the few seconds between two HTTP calls, which the
bounded step size already allows for.

**Unverified against the real driver**, and each is for DV-034 to confirm:
whether the Celestron ASCOM driver reports `CanSlewAltAzAsync` (if it does not,
`connect` refuses and the mount is not usable through this path); whether `Park`
returns only once parked; and the park timeout below.
"""

from __future__ import annotations

import http.client
import ipaddress
import itertools
import json
import logging
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

from contracts.models import DeviceHealth, ObservatoryMode
from darkview_agent.devices.base import (
    DeviceError,
    MountDriver,
    MountStatus,
    NotConnectedError,
)

logger = logging.getLogger("darkview.agent.alpaca")

#: (HTTP method, path, parameters, timeout seconds) -> (HTTP status, body).
Transport = Callable[[str, str, dict[str, str], float], tuple[int, bytes]]

REQUEST_TIMEOUT_SECONDS = 5.0

#: Park and unpark may not return until the motion is over. A 6SE crossing the
#: whole sky at full rate takes well under this; DV-034 replaces it with a
#: measured figure. It bounds a wait, it does not permit any motion.
PARK_TIMEOUT_SECONDS = 180.0

# ASCOM error numbers (ASCOM.ErrorCodes).
ASCOM_NOT_CONNECTED = 0x407
ASCOM_INVALID_WHILE_PARKED = 0x408

#: What the driver must support for this class to keep its interface. Checked on
#: every connect, because a driver swapped or reconfigured between sessions keeps
#: the same address.
REQUIRED_CAPABILITIES = ("canslewaltazasync", "canpark", "canunpark", "cansettracking")


def require_loopback(host: str) -> None:
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError(
            f"Alpaca host {host!r} is not a literal IP address. The bridge is reached on "
            "127.0.0.1 or ::1 only; a name resolves to wherever the hosts file says."
        ) from None
    if not address.is_loopback:
        raise ValueError(
            f"Alpaca host {host} is not a loopback address. The Alpaca bridge listens on "
            "127.0.0.1 only and is never reached from another host."
        )


def http_transport(host: str, port: int) -> Transport:
    require_loopback(host)

    def send(method: str, path: str, params: dict[str, str], timeout: float) -> tuple[int, bytes]:
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
        encoded = urlencode(params)
        try:
            if method == "GET":
                connection.request("GET", f"{path}?{encoded}")
            else:
                connection.request(
                    method,
                    path,
                    body=encoded,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
            response = connection.getresponse()
            return response.status, response.read()
        except (OSError, http.client.HTTPException) as error:
            raise DeviceError(f"Alpaca bridge at {host}:{port} did not answer: {error}") from None
        finally:
            connection.close()

    return send


class AlpacaMount(MountDriver):
    def __init__(
        self,
        host: str,
        port: int,
        device_number: int = 0,
        *,
        transport: Transport | None = None,
        client_id: int = 1,
    ) -> None:
        require_loopback(host)
        self._transport = transport or http_transport(host, port)
        self._base = f"/api/v1/telescope/{device_number}"
        self._client_id = str(client_id)
        self._transaction_ids = itertools.count(1)
        self._connected = False
        self._resume_tracking = False
        self._last_altitude = 0.0
        self._last_azimuth = 0.0

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.real

    # ------------------------------------------------------------------
    # Alpaca
    # ------------------------------------------------------------------

    def _call(
        self,
        method: str,
        member: str,
        params: dict[str, str] | None = None,
        timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> Any:
        payload = {
            **(params or {}),
            "ClientID": self._client_id,
            "ClientTransactionID": str(next(self._transaction_ids)),
        }
        status, body = self._transport(method, f"{self._base}/{member}", payload, timeout)
        if status != 200:
            text = body.decode("utf-8", errors="replace")[:200]
            raise DeviceError(f"Alpaca {method} {member} answered HTTP {status}: {text}")
        try:
            answer = json.loads(body)
            error_number = int(answer.get("ErrorNumber", 0))
        except (ValueError, TypeError, AttributeError):
            raise DeviceError(f"Alpaca {method} {member} answered with no readable JSON") from None

        if error_number == 0:
            return answer.get("Value")
        message = f"Alpaca {member}: ASCOM error 0x{error_number:X}: {answer.get('ErrorMessage')}"
        if error_number in (ASCOM_NOT_CONNECTED, ASCOM_INVALID_WHILE_PARKED):
            raise NotConnectedError(message)
        raise DeviceError(message)

    def _get(self, member: str) -> Any:
        return self._call("GET", member)

    def _put(
        self,
        member: str,
        params: dict[str, str] | None = None,
        timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._call("PUT", member, params, timeout)

    def _require_connection(self) -> None:
        if not self._connected:
            raise NotConnectedError("mount is not connected")

    # ------------------------------------------------------------------
    # MountDriver
    # ------------------------------------------------------------------

    def connect(self) -> None:
        self._put("connected", {"Connected": "True"})
        missing = [name for name in REQUIRED_CAPABILITIES if self._get(name) is not True]
        if missing:
            try:
                self._put("connected", {"Connected": "False"})
            except DeviceError as error:
                logger.error("could not release the refused mount driver: %s", error)
            raise DeviceError(
                f"the mount driver does not support {', '.join(missing)}; AlpacaMount "
                "needs all of them and will not run on a subset"
            )
        self._connected = True

    def disconnect(self) -> None:
        try:
            self.abort_slew()
            self._put("connected", {"Connected": "False"})
        finally:
            self._connected = False
            self._resume_tracking = False

    def status(self) -> MountStatus:
        if not self._connected:
            return MountStatus(
                connected=False,
                slewing=False,
                tracking=False,
                parked=False,
                altitude_degrees=self._last_altitude,
                azimuth_degrees=self._last_azimuth,
                health=DeviceHealth.disconnected,
                mode=self.mode,
            )

        # A driver that dropped its connection answers these reads with ASCOM's
        # NotConnected, which raises. Reporting "not slewing" instead would let a
        # mission believe a slew had finished.
        slewing = self._get("slewing") is True
        tracking = self._get("tracking") is True
        if self._resume_tracking and not slewing:
            self._put("tracking", {"Tracking": "True"})
            self._resume_tracking = False
            tracking = True

        self._last_altitude = float(self._get("altitude"))
        self._last_azimuth = float(self._get("azimuth"))
        return MountStatus(
            connected=True,
            slewing=slewing,
            tracking=tracking,
            parked=self._get("atpark") is True,
            altitude_degrees=self._last_altitude,
            azimuth_degrees=self._last_azimuth,
            health=DeviceHealth.ok,
            mode=self.mode,
        )

    def slew_to(self, altitude_degrees: float, azimuth_degrees: float) -> None:
        self._require_connection()
        paused_tracking = self._get("tracking") is True
        if paused_tracking:
            self._put("tracking", {"Tracking": "False"})
        try:
            self._put(
                "slewtoaltazasync",
                {
                    "Azimuth": repr(float(azimuth_degrees)),
                    "Altitude": repr(float(altitude_degrees)),
                },
            )
        except DeviceError:
            if paused_tracking:
                self._put("tracking", {"Tracking": "True"})
            raise
        self._resume_tracking = self._resume_tracking or paused_tracking

    def abort_slew(self) -> None:
        self._resume_tracking = False
        if not self._connected:
            return
        # AbortSlew on a parked mount is an error in ASCOM, and this must be safe
        # to call on a mount that is not moving.
        if self._get("slewing") is True:
            self._put("abortslew")

    def park(self) -> None:
        """Connects if it has to. Abort is attempted first and its failure ignored.

        A mount that will not abort might still park, and on a heartbeat loss the
        agent may not have connected this session at all.
        """
        self._resume_tracking = False
        if not self._connected:
            self.connect()
        try:
            self.abort_slew()
        except DeviceError as error:
            logger.error("abort before park failed; parking anyway: %s", error)
        self._put("park", timeout=PARK_TIMEOUT_SECONDS)

    def unpark(self) -> None:
        self._require_connection()
        self._put("unpark", timeout=PARK_TIMEOUT_SECONDS)

    def set_tracking(self, tracking: bool) -> None:
        self._require_connection()
        if not tracking:
            self._resume_tracking = False
        elif self._resume_tracking:
            return
        elif self._get("atpark") is True:
            raise NotConnectedError("cannot track while parked")
        self._put("tracking", {"Tracking": str(tracking)})
