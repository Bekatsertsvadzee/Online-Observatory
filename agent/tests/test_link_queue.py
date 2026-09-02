"""The outbound queue.

Small, but it is what holds the observatory's account of what happened while the
cloud was unreachable. Order and content are the whole contract.
"""

from __future__ import annotations

import pytest

from darkview_agent.link.queue import OutboundQueue


def test_a_new_queue_is_empty():
    queue = OutboundQueue()
    assert len(queue) == 0
    assert queue.is_empty is True
    assert queue.peek() is None
    assert queue.dropped_count == 0


def test_messages_come_back_in_the_order_they_went_in():
    queue = OutboundQueue()
    for payload in ("first", "second", "third"):
        queue.append(payload)

    assert queue.snapshot() == ["first", "second", "third"]
    assert queue.pop().payload == "first"
    assert queue.pop().payload == "second"
    assert queue.pop().payload == "third"
    assert queue.is_empty is True


def test_peek_does_not_remove():
    queue = OutboundQueue()
    queue.append("only")

    assert queue.peek().payload == "only"
    assert queue.peek().payload == "only"
    assert len(queue) == 1


def test_payloads_are_stored_verbatim():
    """Nothing is re-encoded on the way through: that is where a timestamp
    quietly becomes a different timestamp."""
    queue = OutboundQueue()
    payload = '{"occurredAt":"2026-09-02T18:04:11.123456+00:00","state":"SLEWING"}'
    queue.append(payload)

    assert queue.peek().payload == payload
    assert queue.pop().payload == payload


def test_a_full_queue_drops_the_oldest_and_counts_it():
    """An observatory can be offline a long time and memory is finite.

    Recent state is more useful to an operator than the start of a stale
    backlog, and the loss is counted rather than hidden.
    """
    queue = OutboundQueue(capacity=3)
    for payload in ("a", "b", "c", "d", "e"):
        queue.append(payload)

    assert len(queue) == 3
    assert queue.snapshot() == ["c", "d", "e"]
    assert queue.dropped_count == 2


def test_capacity_is_reported():
    assert OutboundQueue(capacity=42).capacity == 42


def test_a_non_positive_capacity_is_rejected():
    for invalid in (0, -1):
        with pytest.raises(ValueError):
            OutboundQueue(capacity=invalid)


def test_dropping_only_starts_once_the_queue_is_actually_full():
    queue = OutboundQueue(capacity=2)
    queue.append("a")
    queue.append("b")
    assert queue.dropped_count == 0

    queue.append("c")
    assert queue.dropped_count == 1
