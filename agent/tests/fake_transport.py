"""A transport a test can break on purpose.

You cannot ask a real socket to die on the fourth attempt, at a chosen instant,
after delivering two frames. That is exactly the situation the reconnect and
replay policy exists for, so it is exactly what has to be reproducible.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import uuid4

from darkview_agent.link.transport import ConnectFailed, Transport, TransportError


class FakeTransport(Transport):
    """One connection. Records what was sent, replays what a test queues."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._inbox: list[str] = []
        self._open = True
        self.close_count = 0
        self.fail_send_after: int | None = None

    @property
    def is_open(self) -> bool:
        return self._open

    def send(self, payload: str) -> None:
        if not self._open:
            raise TransportError("connection is not open")
        if self.fail_send_after is not None and len(self.sent) >= self.fail_send_after:
            self._open = False
            raise TransportError("connection reset by peer")
        self.sent.append(payload)

    def receive(self) -> str | None:
        return self._inbox.pop(0) if self._inbox else None

    def close(self) -> None:
        self.close_count += 1
        self._open = False

    # -- test controls -------------------------------------------------

    def deliver(self, message: dict) -> None:
        """Queue a message for the agent to read."""
        self._inbox.append(json.dumps(message))

    def deliver_welcome(
        self, protocol_version: str = "1", heartbeat_interval_seconds: int = 5
    ) -> None:
        self.deliver(
            {
                "type": "CLOUD_WELCOME",
                "messageId": str(uuid4()),
                "sentAt": datetime.now(UTC).isoformat(),
                "protocolVersion": protocol_version,
                "serverTime": datetime.now(UTC).isoformat(),
                "expectedMissionId": None,
                "heartbeatIntervalSeconds": heartbeat_interval_seconds,
            }
        )

    def kill(self) -> None:
        """The peer vanished, without a clean close."""
        self._open = False

    def sent_of_type(self, message_type: str) -> list[dict]:
        return [
            message
            for message in (json.loads(payload) for payload in self.sent)
            if message.get("type") == message_type
        ]


class Connector:
    """Hands out FakeTransports and records every dial-out attempt.

    `fail_next` makes the given number of following attempts fail, which is how
    a test walks the backoff curve.
    """

    def __init__(self) -> None:
        self.transports: list[FakeTransport] = []
        self.attempts = 0
        self.fail_next = 0

    def __call__(self) -> Transport:
        self.attempts += 1
        if self.fail_next > 0:
            self.fail_next -= 1
            raise ConnectFailed("no route to host")
        transport = FakeTransport()
        self.transports.append(transport)
        return transport

    @property
    def current(self) -> FakeTransport:
        return self.transports[-1]
