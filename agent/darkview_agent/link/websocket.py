"""The real outbound WebSocket transport.

Two things this file exists to get right.

**It dials out, and only out.** No socket is bound, no port is listened on. The
observatory is not addressable from the internet or from the LAN.

**The device token never reaches a log.** It goes in an Authorization header,
never in the URL — URLs end up in logs, proxies, and exception messages. Any
exception raised here is scrubbed before it propagates, because exceptions get
logged and a token in a log file is a token that has leaked.
"""

from __future__ import annotations

import contextlib
import queue
import threading

from darkview_agent.link.transport import ConnectFailed, Transport, TransportError

RECEIVE_QUEUE_LIMIT = 500


def redact(text: str, secret: str | None) -> str:
    """Replace a secret with a marker wherever it appears."""
    if not secret:
        return text
    return text.replace(secret, "[REDACTED]")


class WebSocketTransport(Transport):
    """A `websockets` connection, adapted to the polled Transport interface.

    The library is blocking, so a reader thread drains the socket into a queue
    and `receive()` takes from that queue without blocking. The link's pump stays
    responsive: heartbeats are never stuck behind an idle socket.
    """

    def __init__(self, url: str, device_token: str) -> None:
        self._url = url
        self._token = device_token
        self._connection = None
        self._inbox: queue.Queue[str] = queue.Queue(maxsize=RECEIVE_QUEUE_LIMIT)
        self._reader: threading.Thread | None = None
        self._closed = threading.Event()
        self._open = False

    def connect(self) -> None:
        # Imported here rather than at module scope so that importing the agent
        # does not require the websockets library to be installed. The simulator
        # and the safety envelope must remain importable without it.
        try:
            from websockets.sync.client import connect as websocket_connect
        except ImportError as error:  # pragma: no cover - environment dependent
            raise ConnectFailed(
                "the websockets package is required for the real link transport"
            ) from error

        try:
            self._connection = websocket_connect(
                self._url,
                additional_headers={"Authorization": f"Bearer {self._token}"},
                open_timeout=10,
                close_timeout=5,
            )
        except Exception as error:
            raise ConnectFailed(redact(str(error), self._token)) from None

        self._open = True
        self._closed.clear()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self) -> None:
        assert self._connection is not None
        try:
            for frame in self._connection:
                if self._closed.is_set():
                    return
                text = frame if isinstance(frame, str) else frame.decode("utf-8")
                try:
                    self._inbox.put_nowait(text)
                except queue.Full:
                    # Dropping the oldest keeps the newest cloud state, which is
                    # what the agent needs to act on.
                    try:
                        self._inbox.get_nowait()
                        self._inbox.put_nowait(text)
                    except (queue.Empty, queue.Full):
                        pass
        except Exception:
            # The connection died. `is_open` reports it; the session reconnects.
            pass
        finally:
            self._open = False

    @property
    def is_open(self) -> bool:
        return self._open

    def send(self, payload: str) -> None:
        if self._connection is None or not self._open:
            raise TransportError("connection is not open")
        try:
            self._connection.send(payload)
        except Exception as error:
            self._open = False
            raise TransportError(redact(str(error), self._token)) from None

    def receive(self) -> str | None:
        try:
            return self._inbox.get_nowait()
        except queue.Empty:
            return None

    def close(self) -> None:
        self._closed.set()
        self._open = False
        if self._connection is not None:
            with contextlib.suppress(Exception):
                self._connection.close()
            self._connection = None


def build_connector(url: str, device_token: str):
    """A callable the LinkSession can use to dial out.

    Returns a fresh transport per attempt: a dead connection is never revived,
    it is replaced.
    """

    def connect() -> Transport:
        transport = WebSocketTransport(url, device_token)
        transport.connect()
        return transport

    return connect
