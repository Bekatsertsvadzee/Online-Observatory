"""The agent's own record of what it was asked and what it decided.

Written locally, before and independently of anything the cloud records. If the
cloud's account and the observatory's account ever disagree, this is the one
written by the machine that actually holds the telescope.

DV-027 gives this durability across a restart. Until then it is in memory, which
is honest about what it currently guarantees: nothing survives a crash yet.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class AuditEvent:
    """One thing that happened, as the agent saw it."""

    occurred_at: datetime
    kind: str
    command_id: str | None = None
    reason: str | None = None
    detail: str = ""
    context: dict[str, Any] = field(default_factory=dict)


class AuditLog:
    """Append-only. Entries are never edited or removed.

    Bounded, because an agent runs for months. When the bound is reached the
    oldest entries are dropped and counted — losing the beginning of a long
    history is acceptable, silently pretending it was never there is not.
    """

    def __init__(self, capacity: int = 5000) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._events: list[AuditEvent] = []
        self._discarded = 0

    def __len__(self) -> int:
        return len(self._events)

    @property
    def discarded_count(self) -> int:
        return self._discarded

    def record(self, event: AuditEvent) -> AuditEvent:
        if len(self._events) >= self._capacity:
            self._events.pop(0)
            self._discarded += 1
        self._events.append(event)
        return event

    def events(self) -> list[AuditEvent]:
        return list(self._events)

    def events_of_kind(self, kind: str) -> list[AuditEvent]:
        return [event for event in self._events if event.kind == kind]

    def events_for_command(self, command_id: str) -> list[AuditEvent]:
        return [event for event in self._events if event.command_id == command_id]
