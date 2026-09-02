"""The real WebSocketTransport, against a real loopback server.

Everything else in DV-021 tests policy through a fake. This tests the adapter
itself: that it dials out, sends the token in an Authorization header rather than
in the URL, reads frames without blocking, and reports a dropped connection.

The server here belongs to the test, not to the agent. The agent still binds
nothing — that is what test_link_no_listening_ports.py asserts, and this file
closes its own server so the two do not interfere.
"""

from __future__ import annotations

import json
import threading
import time
from uuid import uuid4

import pytest
from websockets.sync.server import serve

from darkview_agent.clock import SystemClock
from darkview_agent.link.session import LinkSession
from darkview_agent.link.transport import ConnectFailed
from darkview_agent.link.websocket import WebSocketTransport, build_connector

TOKEN = "dv-real-transport-token-8821-DO-NOT-LOG"


class RecordingServer:
    """A loopback WebSocket server that records what the agent sent it."""

    def __init__(self) -> None:
        self.received: list[str] = []
        self.authorization_headers: list[str | None] = []
        self.request_paths: list[str] = []
        self._server = None
        self._thread: threading.Thread | None = None
        self.port = 0
        self._to_send: list[str] = []

    def _handler(self, connection) -> None:
        request = connection.request
        self.authorization_headers.append(request.headers.get("Authorization"))
        self.request_paths.append(request.path)

        for payload in self._to_send:
            connection.send(payload)

        try:
            for message in connection:
                self.received.append(message)
        except Exception:
            pass

    def queue_for_client(self, message: dict) -> None:
        self._to_send.append(json.dumps(message))

    def start(self) -> None:
        self._server = serve(self._handler, "127.0.0.1", 0)
        self.port = self._server.socket.getsockname()[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server = None

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/agent"


@pytest.fixture
def server():
    instance = RecordingServer()
    instance.start()
    try:
        yield instance
    finally:
        instance.stop()


def wait_until(predicate, timeout: float = 5.0) -> bool:
    """Poll a condition. Real sockets are asynchronous; this is not a sleep."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_the_transport_connects_and_sends(server):
    transport = WebSocketTransport(server.url, TOKEN)
    transport.connect()
    try:
        assert transport.is_open is True
        transport.send('{"type":"AGENT_HELLO"}')
        assert wait_until(lambda: len(server.received) == 1)
        assert json.loads(server.received[0])["type"] == "AGENT_HELLO"
    finally:
        transport.close()


def test_the_token_travels_in_the_authorization_header_not_the_url(server):
    """URLs end up in logs, proxies and exception messages. Headers do not."""
    transport = WebSocketTransport(server.url, TOKEN)
    transport.connect()
    try:
        assert wait_until(lambda: len(server.authorization_headers) == 1)
        assert server.authorization_headers[0] == f"Bearer {TOKEN}"
        assert TOKEN not in server.request_paths[0]
    finally:
        transport.close()


def test_frames_from_the_server_are_readable_without_blocking(server):
    server.queue_for_client({"type": "CLOUD_COMMAND", "commandId": str(uuid4())})
    transport = WebSocketTransport(server.url, TOKEN)
    transport.connect()
    try:
        received: list[str] = []

        def poll() -> bool:
            frame = transport.receive()
            if frame is not None:
                received.append(frame)
            return bool(received)

        assert wait_until(poll), "no frame arrived from the server"
        assert json.loads(received[0])["type"] == "CLOUD_COMMAND"
        # Nothing else pending: receive returns immediately rather than blocking.
        started = time.monotonic()
        assert transport.receive() is None
        assert time.monotonic() - started < 0.1, "receive blocked on an empty inbox"
    finally:
        transport.close()


def test_closing_the_transport_reports_it_as_closed(server):
    transport = WebSocketTransport(server.url, TOKEN)
    transport.connect()
    transport.close()
    assert transport.is_open is False


def test_close_is_safe_to_call_twice(server):
    transport = WebSocketTransport(server.url, TOKEN)
    transport.connect()
    transport.close()
    transport.close()


def test_a_refused_connection_raises_connect_failed():
    """Nothing is listening on this port."""
    transport = WebSocketTransport("ws://127.0.0.1:1/agent", TOKEN)
    with pytest.raises(ConnectFailed) as raised:
        transport.connect()
    assert TOKEN not in str(raised.value)


def test_a_full_session_handshakes_over_a_real_socket(server):
    """End to end: dial out, AgentHello, CloudWelcome, online, heartbeat."""
    server.queue_for_client(
        {
            "type": "CLOUD_WELCOME",
            "messageId": str(uuid4()),
            "sentAt": "2026-09-02T20:00:00+00:00",
            "protocolVersion": "1",
            "serverTime": "2026-09-02T20:00:00+00:00",
            "expectedMissionId": None,
            "heartbeatIntervalSeconds": 5,
        }
    )

    session = LinkSession(
        observatory_id=uuid4(),
        agent_version="0.1.0",
        connect=build_connector(server.url, TOKEN),
        clock=SystemClock(),
    )

    session.pump()
    assert wait_until(lambda: (session.pump(), session.is_online)[1])

    assert session.is_online
    assert wait_until(lambda: len(server.received) >= 2)

    types = [json.loads(payload)["type"] for payload in server.received]
    assert "AGENT_HELLO" in types
    assert "AGENT_HEARTBEAT" in types

    for payload in server.received:
        assert TOKEN not in payload
