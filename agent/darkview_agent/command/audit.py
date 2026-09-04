"""The agent's own record of what it was asked and what it decided.

Written locally, before and independently of anything the cloud records. If the
cloud's account and the observatory's account ever disagree, this is the one
written by the machine that actually holds the telescope.

DV-027 gave it durability. The in-memory copy is still here and still bounded --
it is what the rest of the agent reads -- but every event is also handed to a
sink that writes it to the local state store, where it survives the crash that
made it worth recording.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

logger = logging.getLogger("darkview.agent.audit")


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

    def __init__(
        self,
        capacity: int = 5000,
        sink: Callable[[AuditEvent], None] | None = None,
    ) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        # Where events go to survive a restart. None means memory only, which is
        # what a test wants and what the agent had before DV-027.
        self._sink = sink
        self._events: list[AuditEvent] = []
        self._discarded = 0
        self._sink_failures = 0

    def __len__(self) -> int:
        return len(self._events)

    @property
    def discarded_count(self) -> int:
        return self._discarded

    @property
    def sink_failures(self) -> int:
        """How many events could not be written durably.

        Not zero-or-crash. The watchdog records what it is about to do *before*
        it does it, so an exception here would stop a Park to protect a log
        entry. A telescope that parked without a record beats a record of a
        telescope that did not park.
        """
        return self._sink_failures

    def record(self, event: AuditEvent) -> AuditEvent:
        if len(self._events) >= self._capacity:
            self._events.pop(0)
            self._discarded += 1
        self._events.append(event)

        if self._sink is not None:
            try:
                self._sink(event)
            except Exception:
                self._sink_failures += 1
                logger.exception("could not write an audit event to the state store")

        return event

    def events(self) -> list[AuditEvent]:
        return list(self._events)

    def events_of_kind(self, kind: str) -> list[AuditEvent]:
        return [event for event in self._events if event.kind == kind]

    def events_for_command(self, command_id: str) -> list[AuditEvent]:
        return [event for event in self._events if event.command_id == command_id]
