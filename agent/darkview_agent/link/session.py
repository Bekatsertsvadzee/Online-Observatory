"""The outbound link to the cloud.

The observatory dials out. It accepts no inbound connection from the internet or
the LAN, opens no listening socket, and is not addressable. If the cloud is
unreachable the agent keeps working and queues what it needs to say.

This is a polled state machine rather than a thread or a coroutine. `pump()` is
called by the agent's main loop and does whatever the clock says is due:
reconnect, heartbeat, drain the queue, read what arrived. That makes the whole
reconnect and replay policy testable at a chosen instant, which is the only way
to have any confidence in behaviour that only occurs during a network failure.
"""

from __future__ import annotations

import contextlib
import json
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from enum import StrEnum

from contracts.models import ObservatoryMode
from darkview_agent.clock import Clock, SystemClock
from darkview_agent.link.queue import OutboundQueue
from darkview_agent.link.transport import Transport, TransportError

logger = logging.getLogger("darkview.agent.link")

PROTOCOL_VERSION = "1"

INITIAL_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 60.0
BACKOFF_MULTIPLIER = 2.0
DEFAULT_HEARTBEAT_SECONDS = 5


class LinkState(StrEnum):
    DISCONNECTED = "DISCONNECTED"
    AWAITING_WELCOME = "AWAITING_WELCOME"
    ONLINE = "ONLINE"
    REFUSED = "REFUSED"


class ProtocolVersionRefused(Exception):
    """The cloud does not support this agent's protocol version."""


ConnectTransport = Callable[[], Transport]


class LinkSession:
    """One long-lived conversation with the cloud, across any number of sockets.

    Heartbeat sequence numbers and the outbound queue survive reconnection: they
    belong to the session, not to a socket. A sequence that restarted on every
    reconnect would make gap detection on the cloud side meaningless.
    """

    def __init__(
        self,
        observatory_id: uuid.UUID,
        agent_version: str,
        connect: ConnectTransport,
        clock: Clock | None = None,
        queue: OutboundQueue | None = None,
        mode: ObservatoryMode = ObservatoryMode.simulated,
    ) -> None:
        self._observatory_id = observatory_id
        self._agent_version = agent_version
        self._connect = connect
        self._clock = clock or SystemClock()
        # Not `queue or OutboundQueue()`: OutboundQueue defines __len__, so an
        # empty one is falsy and an injected queue would be silently discarded.
        self._queue = OutboundQueue() if queue is None else queue
        self._mode = mode

        self._state = LinkState.DISCONNECTED
        self._transport: Transport | None = None
        self._booted_at = datetime.now(UTC)
        self._booted_monotonic = self._clock.monotonic()

        self._heartbeat_sequence = 0
        self._heartbeat_interval = float(DEFAULT_HEARTBEAT_SECONDS)
        self._last_heartbeat_at: float | None = None

        self._backoff = INITIAL_BACKOFF_SECONDS
        self._next_attempt_at = self._clock.monotonic()
        self._connect_attempts = 0

        self._safety_envelope_configured = False
        self._resume_mission_id: uuid.UUID | None = None
        self._received: list[dict] = []

    # ------------------------------------------------------------------
    # Observable state
    # ------------------------------------------------------------------

    @property
    def state(self) -> LinkState:
        return self._state

    @property
    def is_online(self) -> bool:
        return self._state is LinkState.ONLINE

    @property
    def queued_count(self) -> int:
        return len(self._queue)

    @property
    def heartbeat_sequence(self) -> int:
        return self._heartbeat_sequence

    @property
    def connect_attempts(self) -> int:
        return self._connect_attempts

    @property
    def backoff_seconds(self) -> float:
        """The delay that will be applied after the *next* failure.

        Use `seconds_until_retry` to ask how long the current wait still has to
        run; confusing the two is an easy way to write a test that passes for the
        wrong reason.
        """
        return self._backoff

    @property
    def seconds_until_retry(self) -> float:
        """How much longer before the next dial-out attempt is due."""
        return max(0.0, self._next_attempt_at - self._clock.monotonic())

    def set_safety_envelope_configured(self, configured: bool) -> None:
        """Reported in AgentHello so the cloud will not schedule against an
        unmeasured observatory."""
        self._safety_envelope_configured = configured

    def set_resume_mission(self, mission_id: uuid.UUID | None) -> None:
        self._resume_mission_id = mission_id

    def drop(self, reason: str) -> None:
        """Close the current connection and re-dial after the usual backoff.

        The contract's answer to a fatal CLOUD_ERROR: "the agent closes the link,
        backs off and re-dials. It does not stop enforcing safety while
        disconnected." Queued messages survive, because they belong to the
        session rather than to the socket.
        """
        if self._state is LinkState.DISCONNECTED:
            return
        self._handle_disconnection(reason)

    def take_received(self) -> list[dict]:
        """Hand over everything that arrived since the last call."""
        received, self._received = self._received, []
        return received

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------

    def send(self, message: dict) -> None:
        """Queue a message for the cloud.

        Always queues first, then drains. A message is never handed straight to
        the socket, because a send that fails halfway would otherwise be lost
        rather than replayed.

        Never raises because the link is down. Callers are mission code reporting
        that something happened; a state transition is not cancelled by a network
        problem, it is recorded and sent later.
        """
        self._queue.append(json.dumps(message, separators=(",", ":")))
        if self.is_online:
            try:
                self._drain()
            except TransportError as error:
                self._handle_disconnection(f"send failed: {error}")

    # ------------------------------------------------------------------
    # The pump
    # ------------------------------------------------------------------

    def pump(self) -> None:
        """Do whatever the clock says is due. Called from the agent's main loop."""
        if self._state is LinkState.REFUSED:
            return

        if self._state is LinkState.DISCONNECTED:
            self._attempt_connect()
            return

        # A closed socket is noticed here rather than at the next failed send.
        # Waiting for a send would leave a dead link looking healthy for as long
        # as the agent happened to have nothing to say, and the watchdog reads
        # heartbeat cadence to decide whether to Park.
        if self._transport is not None and not self._transport.is_open:
            self._handle_disconnection("peer closed the connection")
            return

        try:
            self._read_available()
            if self._state is LinkState.ONLINE:
                self._send_heartbeat_if_due()
                self._drain()
        except TransportError as error:
            self._handle_disconnection(f"transport error: {error}")

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------

    def _attempt_connect(self) -> None:
        now = self._clock.monotonic()
        if now < self._next_attempt_at:
            return

        self._connect_attempts += 1
        try:
            self._transport = self._connect()
        except TransportError as error:
            self._schedule_retry(f"connect failed: {error}")
            return

        self._state = LinkState.AWAITING_WELCOME
        try:
            self._transport.send(json.dumps(self._hello(), separators=(",", ":")))
        except TransportError as error:
            self._handle_disconnection(f"hello failed: {error}")

    def _hello(self) -> dict:
        return {
            "type": "AGENT_HELLO",
            "messageId": str(uuid.uuid4()),
            "sentAt": datetime.now(UTC).isoformat(),
            "protocolVersion": PROTOCOL_VERSION,
            "observatoryId": str(self._observatory_id),
            "agentVersion": self._agent_version,
            "mode": self._mode.value,
            "bootedAt": self._booted_at.isoformat(),
            "safetyEnvelopeConfigured": self._safety_envelope_configured,
            "resumeMissionId": (
                str(self._resume_mission_id) if self._resume_mission_id else None
            ),
        }

    def _handle_welcome(self, message: dict) -> None:
        version = message.get("protocolVersion")
        if version != PROTOCOL_VERSION:
            logger.error(
                "cloud refused protocol version: agent speaks %s, cloud offered %s",
                PROTOCOL_VERSION,
                version,
            )
            self._close_transport()
            self._state = LinkState.REFUSED
            raise ProtocolVersionRefused(
                f"agent protocol {PROTOCOL_VERSION}, cloud {version}"
            )

        interval = message.get("heartbeatIntervalSeconds") or DEFAULT_HEARTBEAT_SECONDS
        self._heartbeat_interval = float(interval)
        self._state = LinkState.ONLINE
        self._backoff = INITIAL_BACKOFF_SECONDS
        self._last_heartbeat_at = None
        logger.info(
            "link online: heartbeat every %ss, %d queued message(s) to replay",
            self._heartbeat_interval,
            len(self._queue),
        )
        self._drain()

    def _schedule_retry(self, reason: str) -> None:
        self._close_transport()
        self._state = LinkState.DISCONNECTED
        self._next_attempt_at = self._clock.monotonic() + self._backoff
        logger.warning("link down (%s); retrying in %.1fs", reason, self._backoff)
        self._backoff = min(self._backoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_SECONDS)

    def _handle_disconnection(self, reason: str) -> None:
        self._schedule_retry(reason)

    def _close_transport(self) -> None:
        if self._transport is not None:
            # Already gone is a fine outcome here; there is nothing to recover.
            with contextlib.suppress(TransportError):
                self._transport.close()
            self._transport = None

    # ------------------------------------------------------------------
    # Reading, heartbeating, draining
    # ------------------------------------------------------------------

    def _read_available(self) -> None:
        if self._transport is None:
            return
        while True:
            raw = self._transport.receive()
            if raw is None:
                return
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning("discarding a frame that was not valid JSON")
                continue

            if message.get("type") == "CLOUD_WELCOME":
                self._handle_welcome(message)
            else:
                self._received.append(message)

    def _send_heartbeat_if_due(self) -> None:
        now = self._clock.monotonic()
        if (
            self._last_heartbeat_at is not None
            and now - self._last_heartbeat_at < self._heartbeat_interval
        ):
            return

        heartbeat = {
            "type": "AGENT_HEARTBEAT",
            "messageId": str(uuid.uuid4()),
            "sentAt": datetime.now(UTC).isoformat(),
            "sequence": self._heartbeat_sequence,
            "uptimeSeconds": int(now - self._booted_monotonic),
        }
        assert self._transport is not None
        self._transport.send(json.dumps(heartbeat, separators=(",", ":")))
        self._heartbeat_sequence += 1
        self._last_heartbeat_at = now

    def _drain(self) -> None:
        """Send queued messages in order, stopping at the first failure.

        A message is removed only after the send returns. If the socket dies
        mid-drain the unsent remainder stays queued, in order, for the next
        connection.
        """
        if self._transport is None:
            return
        while not self._queue.is_empty:
            pending = self._queue.peek()
            assert pending is not None
            self._transport.send(pending.payload)
            self._queue.pop()
