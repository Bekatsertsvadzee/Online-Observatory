"""The agent's durable memory.

These run against the real SQLite implementation, not a fake. SQLite takes
`:memory:`, so the rules worth proving -- that the audit cannot be rewritten,
that a decided command is still decided after a reopen -- are proved against the
same SQL the observatory runs. A fake store here would prove only that the fake
agrees with itself.

The durability tests use a real file, because a store that survives a restart is
the whole point and an in-memory database cannot demonstrate it.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from darkview_agent.command.audit import AuditEvent, AuditLog
from darkview_agent.state.store import (
    AUDIT_RETENTION_DAYS,
    SEEN_COMMAND_RETENTION_DAYS,
    StateStore,
    StoredOwnership,
)
from tests.envelope_fixtures import build_config

NOW = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)


@pytest.fixture
def store():
    subject = StateStore(":memory:")
    yield subject
    subject.close()


@pytest.fixture
def on_disk(tmp_path):
    return tmp_path / "agent-state.sqlite3"


def event(kind: str = "COMMAND_ACCEPTED", **fields) -> AuditEvent:
    return AuditEvent(occurred_at=fields.pop("occurred_at", NOW), kind=kind, **fields)


# ----------------------------------------------------------------------
# Idempotency
# ----------------------------------------------------------------------


def test_a_decided_command_is_still_decided_after_a_restart(on_disk):
    """The guarantee `docs/observatory-protocol.md` requires before hardware.

    A slew delivered twice because the agent forgot it had already run it is the
    highest-consequence duplicate in the system, and a restart is exactly when a
    retry arrives.
    """
    command_id = str(uuid4())

    first = StateStore(on_disk)
    first.remember(command_id, NOW)
    assert first.has(command_id) is True
    first.close()

    second = StateStore(on_disk)
    assert second.has(command_id) is True
    assert second.has(str(uuid4())) is False
    second.close()


def test_remembering_the_same_command_twice_does_not_raise(store):
    """The retry this table exists to catch must not blow up on its way to being
    refused."""
    command_id = str(uuid4())
    store.remember(command_id, NOW)
    store.remember(command_id, NOW + timedelta(seconds=5))

    assert store.seen_count() == 1


# ----------------------------------------------------------------------
# The audit log
# ----------------------------------------------------------------------


def test_the_audit_survives_a_restart(on_disk):
    first = StateStore(on_disk)
    first.append_audit(event("WATCHDOG_TRIGGERED", reason="LINK_DEAD", detail="60s"))
    first.close()

    second = StateStore(on_disk)
    recovered = second.audit_events()
    second.close()

    assert len(recovered) == 1
    assert recovered[0].kind == "WATCHDOG_TRIGGERED"
    assert recovered[0].reason == "LINK_DEAD"
    assert recovered[0].detail == "60s"
    assert recovered[0].occurred_at == NOW


def test_the_audit_cannot_be_rewritten(store):
    """Append-only, enforced by the database rather than by convention.

    This is the account written by the machine that actually holds the telescope.
    Its whole value is that nobody can revise it afterwards, so the rule belongs
    somewhere that does not depend on every future caller being careful.
    """
    store.append_audit(event("COMMAND_REJECTED", reason="SAFETY_SUN_EXCLUSION"))

    with pytest.raises(sqlite3.IntegrityError) as raised:
        store._connection.execute("UPDATE audit_event SET reason = 'NONE'")

    assert "append-only" in str(raised.value)
    assert store.audit_events()[0].reason == "SAFETY_SUN_EXCLUSION"


def test_events_come_back_in_the_order_they_happened(store):
    for index in range(5):
        store.append_audit(event(detail=str(index), occurred_at=NOW))

    assert [entry.detail for entry in store.audit_events()] == ["0", "1", "2", "3", "4"]
    assert [entry.detail for entry in store.audit_events(limit=2)] == ["3", "4"]


def test_context_survives_the_round_trip(store):
    store.append_audit(event(context={"missionId": "m-1", "stopCapture": True}))

    assert store.audit_events()[0].context == {"missionId": "m-1", "stopCapture": True}


def test_the_audit_log_writes_through_to_the_store(store):
    """`AuditLog` keeps a bounded copy in memory and a durable one here."""
    log = AuditLog(sink=store.append_audit)
    log.record(event("COMMAND_ACCEPTED", command_id="c-1"))

    assert len(log) == 1
    assert store.audit_count() == 1
    assert log.sink_failures == 0


def test_a_failing_sink_does_not_stop_the_agent_recording():
    """The watchdog audits what it is about to do *before* it does it.

    An exception here would stop a Park to protect a log entry. A telescope that
    parked without a record beats a record of a telescope that did not park.
    """

    def broken(_event):
        raise OSError("no space left on device")

    log = AuditLog(sink=broken)
    log.record(event("WATCHDOG_TRIGGERED"))

    assert len(log) == 1
    assert log.sink_failures == 1


# ----------------------------------------------------------------------
# Ownership
# ----------------------------------------------------------------------


def test_ownership_and_the_spent_allowance_survive_a_restart(on_disk):
    """A restart that refilled the allowance would hand back the drift budget the
    cumulative nudge limit exists to bound."""
    ownership = StoredOwnership(
        mission_id=uuid4(),
        session_id=uuid4(),
        user_id=uuid4(),
        expires_at=NOW + timedelta(minutes=20),
        cumulative_nudge_degrees=0.4,
    )

    first = StateStore(on_disk)
    first.save_ownership(ownership)
    first.close()

    second = StateStore(on_disk)
    recovered = second.load_ownership()
    second.close()

    assert recovered == ownership


def test_clearing_ownership_leaves_nothing_behind(store):
    store.save_ownership(
        StoredOwnership(
            mission_id=uuid4(),
            session_id=uuid4(),
            user_id=uuid4(),
            expires_at=None,
            cumulative_nudge_degrees=0.0,
        )
    )
    store.clear_ownership()

    assert store.load_ownership() is None


def test_unreadable_ownership_is_discarded_rather_than_guessed(store):
    store._put("ownership", {"missionId": "not-a-uuid"})

    assert store.load_ownership() is None
    # And it is gone, so the next boot does not report the same failure again.
    assert store.load_ownership() is None


# ----------------------------------------------------------------------
# The held mission
# ----------------------------------------------------------------------


def test_a_held_mission_survives_a_restart(on_disk):
    mission_id = uuid4()

    first = StateStore(on_disk)
    first.save_mission(mission_id, "CAPTURING", NOW)
    first.close()

    second = StateStore(on_disk)
    recovered = second.load_mission()
    second.close()

    assert recovered is not None
    assert recovered.mission_id == mission_id
    assert recovered.state == "CAPTURING"
    assert recovered.recorded_at == NOW


def test_a_cleared_mission_does_not_come_back(store):
    store.save_mission(uuid4(), "SLEWING", NOW)
    store.clear_mission()

    assert store.load_mission() is None


# ----------------------------------------------------------------------
# The safety envelope
# ----------------------------------------------------------------------


def test_the_measured_envelope_survives_a_reboot_during_an_outage(on_disk):
    """Otherwise an agent that restarted while the network was down comes back
    UNMEASURED and refuses every slew -- safe, and the wrong kind of safe,
    because the limits were measured and known."""
    measured = build_config(max_altitude_degrees=64.0)

    first = StateStore(on_disk)
    first.save_envelope(measured)
    first.close()

    second = StateStore(on_disk)
    recovered = second.load_envelope()
    second.close()

    assert recovered is not None
    assert recovered.max_altitude_degrees == 64.0
    assert recovered.link_dead_seconds == measured.link_dead_seconds


def test_an_unreadable_envelope_is_discarded_rather_than_half_applied(store):
    """Fail closed. A partially readable envelope is not a relaxed envelope; it
    is no envelope, and no envelope refuses every slew."""
    store._put("safety_envelope", {"observatoryId": "nonsense"})

    assert store.load_envelope() is None


def test_an_unmeasured_envelope_round_trips_as_unmeasured(store):
    """`null` means UNMEASURED and must not become a number on the way to disk."""
    store.save_envelope(build_config(max_altitude_degrees=None))

    recovered = store.load_envelope()
    assert recovered is not None
    assert recovered.max_altitude_degrees is None


# ----------------------------------------------------------------------
# Retention and threads
# ----------------------------------------------------------------------


def test_retention_drops_what_is_old_and_keeps_what_is_not(store):
    old = NOW - timedelta(days=SEEN_COMMAND_RETENTION_DAYS + 1)
    ancient = NOW - timedelta(days=AUDIT_RETENTION_DAYS + 1)

    store.remember("old-command", old)
    store.remember("recent-command", NOW - timedelta(hours=1))
    store.append_audit(event(detail="ancient", occurred_at=ancient))
    store.append_audit(event(detail="recent", occurred_at=NOW))

    commands, events = store.prune(NOW)

    assert (commands, events) == (1, 1)
    assert store.has("old-command") is False
    assert store.has("recent-command") is True
    assert [entry.detail for entry in store.audit_events()] == ["recent"]


def test_the_store_is_safe_to_write_from_another_thread():
    """The watchdog runs on its own thread and records before it acts.

    Without `check_same_thread=False` and a lock this raises, and the failure
    would land in the one code path that exists for when everything else has
    already gone wrong.
    """
    subject = StateStore(":memory:")
    failures: list[BaseException] = []

    def write_from_a_watchdog_thread():
        try:
            for index in range(20):
                subject.append_audit(event(detail=f"watchdog-{index}"))
        except BaseException as error:  # noqa: BLE001 - recorded and re-raised below
            failures.append(error)

    thread = threading.Thread(target=write_from_a_watchdog_thread)
    thread.start()
    for index in range(20):
        subject.remember(f"main-{index}", NOW)
    thread.join()

    assert not failures, f"the watchdog thread could not write: {failures[0]}"
    assert subject.audit_count() == 20
    assert subject.seen_count() == 20
    subject.close()
