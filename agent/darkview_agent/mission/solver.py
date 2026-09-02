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

from dataclasses import dataclass
from typing import Protocol

from darkview_agent.devices.frame import Frame


@dataclass(frozen=True)
class SolveResult:
    """Where the frame says the telescope is pointing."""

    right_ascension_hours: float
    declination_degrees: float


class PlateSolver(Protocol):
    def solve(self, frame: Frame) -> SolveResult | None:
        """Return the true pointing, or None if the field could not be solved.

        None is a normal outcome, not an error: thin cloud, a field too sparse to
        match, a trailed frame. The mission runner retries, and gives up after a
        bounded number of attempts.
        """
        ...


class SimSolver(PlateSolver):
    """A solver that converges, and fails when told to.

    Models the real behaviour that matters to the mission runner: the first
    solve reveals a pointing error, each correction reduces it, and a solve can
    simply not work.
    """

    def __init__(
        self,
        initial_error_degrees: float = 0.8,
        convergence_factor: float = 0.2,
        fail_first: int = 0,
        fail_always: bool = False,
    ) -> None:
        self._error = initial_error_degrees
        self._convergence = convergence_factor
        self._remaining_failures = fail_first
        self._fail_always = fail_always
        self.solve_count = 0
        self.commanded: tuple[float, float] | None = None

    def set_commanded_position(self, ra_hours: float, dec_degrees: float) -> None:
        """Tell the solver where the mount was asked to go.

        The solved position is that, plus whatever error remains.
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
            right_ascension_hours=ra_hours,
            declination_degrees=dec_degrees + self._error,
        )
        # Each successful solve is followed by a correction, so the residual
        # error shrinks the way it does on a real mount.
        self._error *= self._convergence
        return solved
