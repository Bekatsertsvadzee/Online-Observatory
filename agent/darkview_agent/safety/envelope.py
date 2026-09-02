"""Safety envelope state.

DV-023 implements the full envelope: horizon mask, Sun avoidance, azimuth
sectors, nudge bounds. DV-020 establishes the one thing that must be true before
any of that is written — an agent with no measured MAX_ALT_SAFE refuses to move.

`SafetyEnvelopeConfig` is imported from the generated contract models. It is not
redefined here and must never be.
"""

from __future__ import annotations

from dataclasses import dataclass

from contracts.models import ErrorCode, SafetyEnvelopeConfig


class SafetyRefusal(Exception):
    """A movement was refused. Carries the contract error code, never a bare string."""

    def __init__(self, code: ErrorCode, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


@dataclass(frozen=True)
class SafetyEnvelope:
    """The agent's local copy of the envelope, and the checks it runs itself.

    The cloud validates commands. This validates them again, independently. A
    cloud-approved command that fails here is refused here.
    """

    config: SafetyEnvelopeConfig | None = None

    @property
    def is_measured(self) -> bool:
        """True only when MAX_ALT_SAFE has been physically measured.

        `None` config and a config with `max_altitude_degrees is None` are both
        UNMEASURED. There is no third state and no default value.
        """
        return self.config is not None and self.config.max_altitude_degrees is not None

    def assert_may_slew(self) -> None:
        """Refuse every slew while the envelope is unmeasured.

        DV-023 adds the coordinate-level checks on top of this. This gate comes
        first and is never bypassed.
        """
        if not self.is_measured:
            raise SafetyRefusal(
                ErrorCode.safety_not_configured,
                "MAX_ALT_SAFE is UNMEASURED. It is measured from the physical optical "
                "train during mount qualification, never guessed and never defaulted. "
                "Every slew is refused until a measured value is recorded.",
            )
