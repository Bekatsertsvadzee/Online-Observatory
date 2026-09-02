"""Acceptance criterion 6 of DV-021: the device token never appears in a log
line, an error message or a telemetry payload.

A token in a log file is a token that has leaked. Log files get copied into
issue reports, pasted into chats, shipped to aggregators and kept far longer than
anyone intends. The agent's token authenticates the observatory itself, so it
must never be written anywhere except the Authorization header it belongs in.

The token used here is a distinctive string so that any appearance of it,
anywhere, is unambiguous.
"""

from __future__ import annotations

import json
import logging
from uuid import uuid4

import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.link.session import LinkSession
from darkview_agent.link.transport import ConnectFailed, TransportError
from darkview_agent.link.websocket import WebSocketTransport, redact
from tests.fake_transport import Connector, FakeTransport

TOKEN = "dv-secret-token-4f9c2ae1-DO-NOT-LOG"


def test_redact_removes_the_token():
    assert redact(f"connection to wss://x?t={TOKEN} failed", TOKEN) == (
        "connection to wss://x?t=[REDACTED] failed"
    )


def test_redact_handles_an_absent_secret():
    assert redact("plain message", None) == "plain message"
    assert redact("plain message", "") == "plain message"


def test_a_failed_connection_does_not_leak_the_token(caplog):
    """The most likely leak: an exception message containing the URL or headers."""
    transport = WebSocketTransport("wss://nonexistent.invalid/agent", TOKEN)

    with caplog.at_level(logging.DEBUG), pytest.raises(ConnectFailed) as raised:
        transport.connect()

    assert TOKEN not in str(raised.value)
    assert TOKEN not in caplog.text


def test_a_send_on_a_closed_connection_does_not_leak_the_token():
    transport = WebSocketTransport("wss://nonexistent.invalid/agent", TOKEN)
    with pytest.raises(TransportError) as raised:
        transport.send("{}")
    assert TOKEN not in str(raised.value)


def test_the_token_is_not_stored_on_the_session():
    """The session never receives the token at all: only the connector holds it."""
    clock, connector = ManualClock(), Connector()
    session = LinkSession(
        observatory_id=uuid4(),
        agent_version="0.1.0",
        connect=connector,
        clock=clock,
    )
    session.pump()
    connector.current.deliver_welcome()
    session.pump()

    assert TOKEN not in repr(session.__dict__)


def test_no_outbound_message_carries_the_token(caplog):
    """Criterion 6: not in a telemetry payload either."""
    clock, connector = ManualClock(), Connector()
    session = LinkSession(
        observatory_id=uuid4(),
        agent_version="0.1.0",
        connect=connector,
        clock=clock,
    )

    with caplog.at_level(logging.DEBUG):
        session.pump()
        connector.current.deliver_welcome()
        session.pump()

        session.send(
            {
                "type": "AGENT_MISSION_EVENT",
                "messageId": str(uuid4()),
                "missionId": str(uuid4()),
                "state": "SLEWING",
                "occurredAt": "2026-09-02T20:00:00+00:00",
            }
        )
        for _ in range(4):
            clock.advance(5.0)
            session.pump()

    for payload in connector.current.sent:
        assert TOKEN not in payload
        assert "Bearer" not in payload
        assert "Authorization" not in json.loads(payload)

    assert TOKEN not in caplog.text


def test_link_lifecycle_logs_stay_clean_through_failures(caplog):
    """Reconnect logging is the noisiest path, so it is the one most likely to leak."""
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 6
    session = LinkSession(
        observatory_id=uuid4(),
        agent_version="0.1.0",
        connect=connector,
        clock=clock,
    )

    with caplog.at_level(logging.DEBUG):
        for _ in range(6):
            session.pump()
            clock.advance(session.seconds_until_retry + 0.1)
        session.pump()
        connector.current.deliver_welcome()
        session.pump()

    assert caplog.text, "expected reconnect logging to have happened"
    assert TOKEN not in caplog.text
    assert "Bearer" not in caplog.text


def test_the_leak_detector_would_notice_a_leak(caplog):
    """Guard the guard: prove caplog actually captures what the link logs."""
    logger = logging.getLogger("darkview.agent.link")
    with caplog.at_level(logging.DEBUG):
        logger.warning("pretend leak %s", TOKEN)
    assert TOKEN in caplog.text


def test_a_transport_error_from_the_fake_carries_no_credentials():
    transport = FakeTransport()
    transport.close()
    with pytest.raises(TransportError) as raised:
        transport.send("{}")
    assert TOKEN not in str(raised.value)
