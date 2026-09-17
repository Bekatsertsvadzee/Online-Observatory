"""Plate solving: where is the telescope actually pointing?

A mount told to go somewhere arrives somewhere near it. Plate solving reads the
star field the camera actually captured and reports the true pointing, so the
difference can be corrected. Without it a mission delivers a customer a picture
of the wrong patch of sky and nobody notices.

DV-030 implements this against ASTAP. This defines the interface the mission
runner uses and a simulated solver that behaves like the real thing: converging
over a few iterations, and able to fail the way a real solve fails on a cloudy
frame or a field with too few stars.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

from darkview_agent.devices.frame import Frame


@dataclass(frozen=True)
class SolveResult:
    """Where the frame says the telescope is pointing."""

    right_ascension_hours: float
    declination_degrees: float


def separation_degrees(
    ra_hours_a: float, dec_degrees_a: float, ra_hours_b: float, dec_degrees_b: float
) -> float:
    """Great-circle distance between two sky positions.

    Both axes, and on the sphere: an hour of right ascension near the pole is a
    small distance, and a comparison of declinations alone cannot see a frame
    that is off by a degree in right ascension at all.
    """
    dec_a, dec_b = math.radians(dec_degrees_a), math.radians(dec_degrees_b)
    delta_ra = math.radians((ra_hours_a - ra_hours_b) * 15.0)
    cosine = math.sin(dec_a) * math.sin(dec_b) + math.cos(dec_a) * math.cos(dec_b) * math.cos(
        delta_ra
    )
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


class PlateSolver(Protocol):
    def solve(self, frame: Frame) -> SolveResult | None:
        """Return the true pointing, or None if the field could not be solved.

        None is a normal outcome, not an error: thin cloud, a field too sparse to
        match, a trailed frame. The mission runner retries, and gives up after a
        bounded number of attempts.
        """
        ...


class SimSolver(PlateSolver):
    """A mount with a pointing error, seen through a solver that can fail.

    The error belongs to the mount, not to the solve: wherever the mount is sent,
    it lands that far away, and a solve reports where it landed. Nothing shrinks
    on its own. Only a correction that sends the mount to the target minus the
    error centres it -- so a runner that re-sends the same position fails here the
    way it would on a real telescope.

    `error_drift_degrees` is a mount whose error changes after every solve by
    that much in declination, which no bounded correction catches.
    """

    def __init__(
        self,
        initial_error_degrees: float = 0.8,
        fail_first: int = 0,
        fail_always: bool = False,
        ra_error_hours: float = 0.0,
        error_drift_degrees: float = 0.0,
    ) -> None:
        self._error = initial_error_degrees
        self._ra_error = ra_error_hours
        self._drift = error_drift_degrees
        self._remaining_failures = fail_first
        self._fail_always = fail_always
        self.solve_count = 0
        self.commanded: tuple[float, float] | None = None

    def set_commanded_position(self, ra_hours: float, dec_degrees: float) -> None:
        """Tell the solver where the mount was asked to go.

        The solved position is that, plus the mount's error.
        """
        self.commanded = (ra_hours, dec_degrees)

    def solve(self, frame: Frame) -> SolveResult | None:
        self.solve_count += 1

        if self._fail_always or self._remaining_failures > 0:
            self._remaining_failures = max(0, self._remaining_failures - 1)
            return None

        if self.commanded is None:
            return None

        ra_hours, dec_degrees = self.commanded
        solved = SolveResult(
            right_ascension_hours=(ra_hours + self._ra_error) % 24.0,
            declination_degrees=max(-90.0, min(90.0, dec_degrees + self._error)),
        )
        self._error += self._drift
        return solved
