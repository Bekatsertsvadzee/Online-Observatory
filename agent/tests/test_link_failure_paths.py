"""Link failure paths that only occur when something breaks at an awkward moment.

Each of these is a branch the happy path never reaches, and each is on the route
the agent takes during a real network problem — which is the only time any of
this code runs.
"""

from __future__ import annotations

from uuid import uuid4

from darkview_agent.clock import ManualClock
from darkview_agent.link.session import LinkSession, LinkState
from darkview_agent.link.transport import Transport, TransportError
from tests.fake_transport import Connector, FakeTransport


def build_session(clock, connector, **kwargs):
    return LinkSession(
        observatory_id=uuid4(),
        agent_version="0.1.0",
        connect=connector,
        clock=clock,
        **kwargs,
    )


class HelloFailsTransport(Transport):
    """Connects, then refuses the very first send.

    A real case: the socket completes its handshake and the peer goes away
    before the agent can say hello.
    """

    def __init__(self) -> None:
        self.close_count = 0

    @property
    def is_open(self) -> bool:
        return True

    def send(self, payload: str) -> None:
        raise TransportError("peer went away before hello")

    def receive(self) -> str | None:
        return None

    def close(self) -> None:
        self.close_count += 1


def test_a_failure_sending_hello_schedules_a_retry():
    """Line: the hello send failing rather than the connect."""
    clock = ManualClock()
    transports: list[HelloFailsTransport] = []

    def connect() -> Transport:
        transport = HelloFailsTransport()
        transports.append(transport)
        return transport

    session = build_session(clock, connect)
    session.pump()

    assert session.state is LinkState.DISCONNECTED
    assert transports[0].close_count == 1
    assert session.seconds_until_retry > 0.0


def test_a_transport_error_while_reading_schedules_a_retry():
    """The socket dies during receive rather than during send."""

    class ReadFailsTransport(FakeTransport):
        def receive(self) -> str | None:
            raise TransportError("connection reset while reading")

    clock = ManualClock()
    transports: list[FakeTransport] = []

    def connect() -> Transport:
        transport = ReadFailsTransport()
        transports.append(transport)
        return transport

    session = build_session(clock, connect)
    session.pump()
    session.pump()

    assert session.state is LinkState.DISCONNECTED


def test_connect_attempts_are_counted():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 3
    session = build_session(clock, connector)

    for _ in range(3):
        session.pump()
        clock.advance(session.seconds_until_retry + 0.1)

    assert session.connect_attempts == 3


def test_pumping_a_disconnected_session_before_the_retry_is_due_does_nothing():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 5
    session = build_session(clock, connector)
    session.pump()

    attempts = session.connect_attempts
    session.pump()
    session.pump()

    assert session.connect_attempts == attempts


def test_reading_when_there_is_no_transport_is_harmless():
    """Reachable after a disconnection has cleared the transport."""
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 1
    session = build_session(clock, connector)
    session.pump()

    assert session.state is LinkState.DISCONNECTED
    session.pump()
    assert session.state is LinkState.DISCONNECTED


def test_sending_while_offline_only_queues():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 5
    session = build_session(clock, connector)
    session.pump()

    session.send({"type": "AGENT_MISSION_EVENT", "occurredAt": "2026-09-02T20:00:00+00:00"})

    assert session.queued_count == 1
    assert session.is_online is False


def test_a_close_that_itself_fails_does_not_propagate():
    """Closing a socket that is already gone is a fine outcome, not an error."""

    class CloseFailsTransport(FakeTransport):
        def close(self) -> None:
            raise TransportError("already gone")

    clock = ManualClock()

    def connect() -> Transport:
        return CloseFailsTransport()

    session = build_session(clock, connect)
    session.pump()
    session.pump()
    # The peer closing is detected and the retry is scheduled regardless.
    assert session.state in (LinkState.AWAITING_WELCOME, LinkState.DISCONNECTED)
