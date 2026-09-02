"""The wire, behind an interface.

The link's job is policy: when to reconnect, how long to back off, when to
heartbeat, what to replay. That policy is what has to be right, and it is what a
network makes impossible to test — you cannot ask a real socket to fail on the
fourth attempt at a chosen instant.

So the socket lives behind this interface. `WebSocketTransport` is the real one;
tests drive a fake. Same shape as the device drivers, for the same reason.
"""

from __future__ import annotations

from typing import Protocol


class TransportError(Exception):
    """The connection failed or was lost.

    Never carries the device token. Transport implementations must not put
    credentials into an exception message: exceptions get logged.
    """


class Transport(Protocol):
    """One open connection to the cloud."""

    @property
    def is_open(self) -> bool: ...

    def send(self, payload: str) -> None:
        """Send one text frame. Raises TransportError if the connection is gone."""
        ...

    def receive(self) -> str | None:
        """Return one pending text frame, or None if nothing has arrived.

        Never blocks. The link is a polled state machine, so a blocking receive
        would stall heartbeats behind an idle socket.
        """
        ...

    def close(self) -> None:
        """Close the connection. Safe to call more than once."""
        ...


class ConnectFailed(TransportError):
    """The dial-out attempt did not establish a connection."""
