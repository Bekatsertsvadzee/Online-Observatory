"""The local audit log.

Small, but it is the observatory's own account of what it was asked and what it
decided. If the cloud's record and this one ever disagree, this is the one
written by the machine that actually holds the telescope.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from darkview_agent.command.audit import AuditEvent, AuditLog

MOMENT = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)


def event(kind: str = "COMMAND_REJECTED", command_id: str = "abc") -> AuditEvent:
    return AuditEvent(
        occurred_at=MOMENT, kind=kind, command_id=command_id, reason="WRONG_SESSION"
    )


def test_a_new_log_is_empty():
    log = AuditLog()
    assert len(log) == 0
    assert log.events() == []
    assert log.discarded_count == 0


def test_events_are_kept_in_order():
    log = AuditLog()
    log.record(event(command_id="first"))
    log.record(event(command_id="second"))

    assert [entry.command_id for entry in log.events()] == ["first", "second"]


def test_record_returns_the_event_it_stored():
    log = AuditLog()
    stored = event()
    assert log.record(stored) is stored


def test_events_can_be_filtered_by_kind():
    log = AuditLog()
    log.record(event(kind="COMMAND_ACCEPTED"))
    log.record(event(kind="COMMAND_REJECTED"))
    log.record(event(kind="COMMAND_REJECTED"))

    assert len(log.events_of_kind("COMMAND_REJECTED")) == 2
    assert len(log.events_of_kind("COMMAND_ACCEPTED")) == 1
    assert log.events_of_kind("NOTHING_LIKE_THIS") == []


def test_events_can_be_filtered_by_command():
    log = AuditLog()
    log.record(event(command_id="wanted"))
    log.record(event(command_id="other"))
    log.record(event(kind="COMMAND_DUPLICATE", command_id="wanted"))

    assert len(log.events_for_command("wanted")) == 2


def test_the_returned_list_is_a_copy():
    """A caller must not be able to edit the record by mutating what it was given."""
    log = AuditLog()
    log.record(event())

    log.events().clear()

    assert len(log) == 1


def test_a_full_log_drops_the_oldest_and_counts_it():
    """An agent runs for months. Losing the beginning of a long history is
    acceptable; silently pretending it was never there is not."""
    log = AuditLog(capacity=3)
    for index in range(5):
        log.record(event(command_id=str(index)))

    assert len(log) == 3
    assert [entry.command_id for entry in log.events()] == ["2", "3", "4"]
    assert log.discarded_count == 2


def test_a_non_positive_capacity_is_rejected():
    for invalid in (0, -1):
        with pytest.raises(ValueError):
            AuditLog(capacity=invalid)


def test_an_event_carries_its_context():
    log = AuditLog()
    log.record(
        AuditEvent(
            occurred_at=MOMENT,
            kind="COMMAND_REJECTED",
            command_id="abc",
            reason="SAFETY_ABOVE_MAX_ALTITUDE",
            detail="Altitude 78.59 is above the measured MAX_ALT_SAFE 68.00.",
            context={"missionId": "m-1", "type": "GOTO"},
        )
    )
    stored = log.events()[0]
    assert stored.context["type"] == "GOTO"
    assert "78.59" in stored.detail
