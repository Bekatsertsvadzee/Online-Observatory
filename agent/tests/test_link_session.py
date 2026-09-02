"""DV-021 — the outbound link.

Every acceptance criterion except the no-listening-ports check, which needs a
real process and lives in test_link_no_listening_ports.py.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from contracts.models import ObservatoryMode
from darkview_agent.clock import ManualClock
from darkview_agent.link.session import (
    INITIAL_BACKOFF_SECONDS,
    MAX_BACKOFF_SECONDS,
    PROTOCOL_VERSION,
    LinkSession,
    LinkState,
    ProtocolVersionRefused,
)
from tests.fake_transport import Connector

OBSERVATORY_ID = uuid4()


def build_session(clock: ManualClock, connector: Connector, **kwargs) -> LinkSession:
    return LinkSession(
        observatory_id=OBSERVATORY_ID,
        agent_version="0.1.0",
        connect=connector,
        clock=clock,
        **kwargs,
    )


def online_session(clock: ManualClock, connector: Connector, **kwargs) -> LinkSession:
    session = build_session(clock, connector, **kwargs)
    session.pump()
    connector.current.deliver_welcome()
    session.pump()
    assert session.is_online
    return session


def mission_event(occurred_at: datetime, state: str = "SLEWING") -> dict:
    return {
        "type": "AGENT_MISSION_EVENT",
        "messageId": str(uuid4()),
        "sentAt": datetime.now(UTC).isoformat(),
        "missionId": str(uuid4()),
        "state": state,
        "occurredAt": occurred_at.isoformat(),
    }


# --------------------------------------------------------------------------
# Criterion 2 — AgentHello and protocol version
# --------------------------------------------------------------------------


def test_hello_is_sent_immediately_on_connect():
    clock, connector = ManualClock(), Connector()
    session = build_session(clock, connector)
    session.pump()

    hellos = connector.current.sent_of_type("AGENT_HELLO")
    assert len(hellos) == 1
    assert session.state is LinkState.AWAITING_WELCOME


def test_hello_carries_protocol_version_mode_and_envelope_state():
    """Criterion 2."""
    clock, connector = ManualClock(), Connector()
    session = build_session(clock, connector, mode=ObservatoryMode.simulated)
    session.set_safety_envelope_configured(False)
    session.pump()

    hello = connector.current.sent_of_type("AGENT_HELLO")[0]
    assert hello["protocolVersion"] == PROTOCOL_VERSION
    assert hello["mode"] == "SIMULATED"
    assert hello["safetyEnvelopeConfigured"] is False
    assert hello["observatoryId"] == str(OBSERVATORY_ID)


def test_envelope_state_is_reported_once_measured():
    clock, connector = ManualClock(), Connector()
    session = build_session(clock, connector)
    session.set_safety_envelope_configured(True)
    session.pump()

    hello = connector.current.sent_of_type("AGENT_HELLO")[0]
    assert hello["safetyEnvelopeConfigured"] is True


def test_a_resumed_mission_is_declared_in_hello():
    clock, connector = ManualClock(), Connector()
    session = build_session(clock, connector)
    mission_id = uuid4()
    session.set_resume_mission(mission_id)
    session.pump()

    assert connector.current.sent_of_type("AGENT_HELLO")[0]["resumeMissionId"] == str(
        mission_id
    )


def test_an_unsupported_protocol_version_closes_the_link_cleanly():
    """Criterion 2: the cloud's rejection closes the link, and it stays closed."""
    clock, connector = ManualClock(), Connector()
    session = build_session(clock, connector)
    session.pump()
    connector.current.deliver_welcome(protocol_version="99")

    with pytest.raises(ProtocolVersionRefused):
        session.pump()

    assert session.state is LinkState.REFUSED
    assert connector.current.close_count == 1


def test_a_refused_link_does_not_retry():
    """A version mismatch is not transient. Reconnecting would hammer the cloud."""
    clock, connector = ManualClock(), Connector()
    session = build_session(clock, connector)
    session.pump()
    connector.current.deliver_welcome(protocol_version="99")
    with pytest.raises(ProtocolVersionRefused):
        session.pump()

    attempts_after_refusal = connector.attempts
    for _ in range(10):
        clock.advance(120.0)
        session.pump()

    assert connector.attempts == attempts_after_refusal


# --------------------------------------------------------------------------
# Criterion 3 — reconnect with increasing backoff
# --------------------------------------------------------------------------


def test_failed_connections_back_off_exponentially():
    """Criterion 3."""
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 5
    session = build_session(clock, connector)

    delays = []
    for _ in range(5):
        session.pump()
        delays.append(session.backoff_seconds)
        clock.advance(session.seconds_until_retry + 0.01)

    assert delays == sorted(delays), f"backoff should increase: {delays}"
    assert len(set(delays)) > 1, "backoff never grew"
    assert delays[0] > INITIAL_BACKOFF_SECONDS


def test_backoff_is_capped():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 40
    session = build_session(clock, connector)

    for _ in range(40):
        session.pump()
        clock.advance(session.seconds_until_retry + 0.01)

    assert session.backoff_seconds <= MAX_BACKOFF_SECONDS


def test_no_reconnect_attempt_before_the_backoff_has_elapsed():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 10
    session = build_session(clock, connector)

    session.pump()
    attempts = connector.attempts
    wait = session.seconds_until_retry
    assert wait > 0.0

    clock.advance(wait / 2.0)
    session.pump()
    assert connector.attempts == attempts, "retried before the backoff elapsed"

    clock.advance(session.seconds_until_retry + 0.01)
    session.pump()
    assert connector.attempts > attempts


def test_the_agent_recovers_when_the_server_returns():
    """Criterion 3: the second half, which is the half that matters."""
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 3
    session = build_session(clock, connector)

    for _ in range(3):
        session.pump()
        clock.advance(session.seconds_until_retry + 0.1)

    session.pump()
    connector.current.deliver_welcome()
    session.pump()

    assert session.is_online


def test_backoff_resets_after_a_successful_connection():
    """Otherwise a single long outage leaves the agent slow to recover forever."""
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 4
    session = build_session(clock, connector)

    for _ in range(4):
        session.pump()
        clock.advance(session.seconds_until_retry + 0.1)
    grown_backoff = session.backoff_seconds

    session.pump()
    connector.current.deliver_welcome()
    session.pump()

    assert session.is_online
    assert session.backoff_seconds < grown_backoff
    assert session.backoff_seconds == INITIAL_BACKOFF_SECONDS


def test_a_dropped_connection_triggers_a_reconnect():
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)

    connector.current.kill()
    clock.advance(10.0)
    session.pump()

    assert session.is_online is False
    assert session.state is LinkState.DISCONNECTED


# --------------------------------------------------------------------------
# Criterion 4 — replay preserves occurredAt
# --------------------------------------------------------------------------


def test_messages_produced_while_offline_are_queued():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 5
    session = build_session(clock, connector)
    session.pump()

    session.send(mission_event(datetime.now(UTC)))
    session.send(mission_event(datetime.now(UTC)))

    assert session.queued_count == 2


def test_a_replayed_mission_event_keeps_its_original_timestamp():
    """Criterion 4, stated by the contract itself: occurredAt is 'replayed
    unchanged after a reconnect; never rewritten to look contemporaneous'."""
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 3
    session = build_session(clock, connector)
    session.pump()

    original_time = datetime.now(UTC) - timedelta(minutes=20)
    session.send(mission_event(original_time))

    # Twenty minutes of outage pass.
    for _ in range(3):
        clock.advance(session.seconds_until_retry + 0.1)
        session.pump()

    session.pump()
    connector.current.deliver_welcome()
    session.pump()

    replayed = connector.current.sent_of_type("AGENT_MISSION_EVENT")
    assert len(replayed) == 1
    assert replayed[0]["occurredAt"] == original_time.isoformat()


def test_replay_preserves_order():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 2
    session = build_session(clock, connector)
    session.pump()

    times = [datetime.now(UTC) - timedelta(minutes=minutes) for minutes in (30, 20, 10)]
    for moment in times:
        session.send(mission_event(moment))

    for _ in range(2):
        clock.advance(session.seconds_until_retry + 0.1)
        session.pump()
    session.pump()
    connector.current.deliver_welcome()
    session.pump()

    replayed = connector.current.sent_of_type("AGENT_MISSION_EVENT")
    assert [event["occurredAt"] for event in replayed] == [
        moment.isoformat() for moment in times
    ]


def test_the_queue_empties_after_replay():
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 1
    session = build_session(clock, connector)
    session.pump()
    session.send(mission_event(datetime.now(UTC)))

    clock.advance(session.seconds_until_retry + 0.1)
    session.pump()
    connector.current.deliver_welcome()
    session.pump()

    assert session.queued_count == 0


def test_a_send_failure_mid_drain_leaves_the_remainder_queued():
    """The unsent remainder must survive, in order, for the next connection."""
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)

    # Allow the hello and one heartbeat, then break the socket.
    connector.current.fail_send_after = len(connector.current.sent) + 1
    session.send(mission_event(datetime.now(UTC)))
    session.send(mission_event(datetime.now(UTC)))

    session.pump()
    assert session.queued_count >= 1


# --------------------------------------------------------------------------
# Criterion 5 — heartbeat sequence is monotonic across a reconnect
# --------------------------------------------------------------------------


def test_heartbeats_are_sent_on_the_interval():
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)

    for _ in range(3):
        clock.advance(5.0)
        session.pump()

    heartbeats = connector.current.sent_of_type("AGENT_HEARTBEAT")
    assert len(heartbeats) >= 3


def test_no_heartbeat_before_the_interval_elapses():
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)
    session.pump()
    before = len(connector.current.sent_of_type("AGENT_HEARTBEAT"))

    clock.advance(1.0)
    session.pump()

    assert len(connector.current.sent_of_type("AGENT_HEARTBEAT")) == before


def test_heartbeat_sequence_numbers_are_monotonic_across_a_reconnect():
    """Criterion 5. The sequence belongs to the session, not to the socket:
    restarting it on reconnect would make cloud-side gap detection meaningless."""
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)

    for _ in range(3):
        clock.advance(5.0)
        session.pump()
    first_socket = connector.current.sent_of_type("AGENT_HEARTBEAT")
    sequence_before = session.heartbeat_sequence

    connector.current.kill()
    clock.advance(1.0)
    session.pump()
    clock.advance(session.seconds_until_retry + 0.1)
    session.pump()
    connector.current.deliver_welcome()
    session.pump()
    assert session.is_online

    for _ in range(3):
        clock.advance(5.0)
        session.pump()
    second_socket = connector.current.sent_of_type("AGENT_HEARTBEAT")

    sequences = [beat["sequence"] for beat in first_socket + second_socket]
    assert sequences == sorted(sequences), f"sequence went backwards: {sequences}"
    assert len(set(sequences)) == len(sequences), f"sequence repeated: {sequences}"
    assert second_socket[0]["sequence"] >= sequence_before


def test_uptime_is_reported_and_grows():
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)

    clock.advance(5.0)
    session.pump()
    clock.advance(60.0)
    session.pump()

    heartbeats = connector.current.sent_of_type("AGENT_HEARTBEAT")
    uptimes = [beat["uptimeSeconds"] for beat in heartbeats]
    assert uptimes == sorted(uptimes)
    assert uptimes[-1] >= 60


# --------------------------------------------------------------------------
# Inbound
# --------------------------------------------------------------------------


def test_cloud_messages_are_handed_to_the_caller():
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)

    connector.current.deliver({"type": "CLOUD_COMMAND", "commandId": str(uuid4())})
    session.pump()

    received = session.take_received()
    assert len(received) == 1
    assert received[0]["type"] == "CLOUD_COMMAND"
    assert session.take_received() == [], "messages should be handed over once"


def test_a_malformed_frame_does_not_break_the_link():
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)

    connector.current._inbox.append("{not json")
    connector.current.deliver({"type": "CLOUD_COMMAND"})
    session.pump()

    assert session.is_online
    assert len(session.take_received()) == 1


def test_the_welcome_is_not_handed_to_the_caller_as_a_command():
    clock, connector = ManualClock(), Connector()
    session = online_session(clock, connector)
    assert session.take_received() == []


# --------------------------------------------------------------------------
# Queue behaviour
# --------------------------------------------------------------------------


def test_messages_are_serialised_once_and_not_re_encoded_on_replay():
    """Re-encoding is where a timestamp gets quietly normalised."""
    clock, connector = ManualClock(), Connector()
    connector.fail_next = 1
    session = build_session(clock, connector)
    session.pump()

    event = mission_event(datetime.now(UTC) - timedelta(hours=2))
    session.send(event)

    clock.advance(session.seconds_until_retry + 0.1)
    session.pump()
    connector.current.deliver_welcome()
    session.pump()

    sent = connector.current.sent_of_type("AGENT_MISSION_EVENT")[0]
    assert sent == json.loads(json.dumps(event))
