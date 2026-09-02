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
from typing import Protocol


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
