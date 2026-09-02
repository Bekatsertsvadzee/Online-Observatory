"""Outbound messages, held while the link is down.

The observatory keeps working when the cloud is unreachable: a mission still
transitions, a capture still completes. Those events are queued and replayed on
reconnect.

The one rule that matters here: a replayed message is byte-for-byte the message
that was queued. `occurredAt` records when something happened on the observatory
clock, and the contract says it is "replayed unchanged after a reconnect; never
rewritten to look contemporaneous". Rewriting it would turn a twenty-minute
outage into an audit trail claiming everything happened at once.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True)
class QueuedMessage:
    """One serialised message, exactly as it will go on the wire."""

    payload: str


class OutboundQueue:
    """A bounded FIFO of messages waiting for the link.

    Bounded because an observatory can be offline for a long time and memory is
    finite. When the bound is reached the *oldest* message is dropped: recent
    state is more useful to an operator than the beginning of a stale backlog,
    and the drop is counted so it can be reported rather than hidden.
    """

    def __init__(self, capacity: int = 1000) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._messages: deque[QueuedMessage] = deque()
        self._dropped = 0

    def __len__(self) -> int:
        return len(self._messages)

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def dropped_count(self) -> int:
        """How many messages were discarded because the queue was full."""
        return self._dropped

    @property
    def is_empty(self) -> bool:
        return not self._messages

    def append(self, payload: str) -> None:
        if len(self._messages) >= self._capacity:
            self._messages.popleft()
            self._dropped += 1
        self._messages.append(QueuedMessage(payload=payload))

    def peek(self) -> QueuedMessage | None:
        return self._messages[0] if self._messages else None

    def pop(self) -> QueuedMessage:
        """Remove the front message. Call only after it has been sent."""
        return self._messages.popleft()

    def snapshot(self) -> list[str]:
        """Every queued payload, in order. For assertions and diagnostics."""
        return [message.payload for message in self._messages]
