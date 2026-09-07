"""Time, injected rather than assumed.

The simulator models slew duration, exposure duration and focuser travel. If it
used the wall clock, a test covering a 90-degree slew would take as long as a
90-degree slew. So time is an interface: production uses the wall clock, tests
advance a fake one by hand.

This is not a testing convenience bolted on afterwards. A device driver that
cannot be driven through its timeline deterministically cannot be tested for the
transitions that matter — abort mid-slew, timeout, heartbeat loss during motion.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Protocol


def wire_timestamp(moment: datetime | None = None) -> str:
    """An instant, spelled the way the contract's `date-time` fields are read.

    UTC with a `Z` suffix, because that is the only spelling the cloud's generated
    validators accept. Python's `isoformat()` writes `+00:00` instead. RFC 3339
    permits both equally, so neither side was wrong on its own -- but they did not
    agree, and the disagreement meant every message this agent sent was refused at
    the parse step. The link never reached ONLINE against the real service.

    Nothing caught it. The Python suite checks the agent against its own fakes,
    the TypeScript suite builds fixtures with `toISOString()`, which writes `Z`,
    and until Milestone S1 nothing had ever run the two halves against each other.

    A naive datetime is taken as UTC. The agent keeps no other clock, and the
    alternative -- `astimezone()` with no argument -- reads the machine's local
    zone and puts an offset like `+04:00` on the wire, which is how the command
    ack came to carry Tbilisi local time.
    """
    at = datetime.now(UTC) if moment is None else moment
    if at.tzinfo is None:
        at = at.replace(tzinfo=UTC)
    return at.astimezone(UTC).isoformat().replace("+00:00", "Z")


class Clock(Protocol):
    def monotonic(self) -> float:
        """Seconds from an arbitrary origin. Only differences are meaningful."""
        ...


class SystemClock:
    """Wall-clock time. The default outside tests."""

    def monotonic(self) -> float:
        return time.monotonic()


class ManualClock:
    """A clock that only moves when a test moves it."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def monotonic(self) -> float:
        return self._now

    def advance(self, seconds: float) -> float:
        if seconds < 0:
            raise ValueError("time does not run backwards")
        self._now += seconds
        return self._now
