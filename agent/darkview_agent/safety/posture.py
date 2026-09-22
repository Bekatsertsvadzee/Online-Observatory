"""The agent's posture: who it believes is at the instrument (ADR-024).

`DARKVIEW_AGENT_ATTENDED` answered one question -- is an operator here? -- and
answered it for the life of the process. That left an approved partner, and a
first-party queued capture, two options: never run real hardware with nobody
present, or set the flag and walk away, which also arms the daylight override
at an instrument nobody is standing beside.

Posture is the honest answer. It has four values and one rule: it only ever
moves towards less.

    SIMULATED   simulated drivers, nobody has declared they are present
    ATTENDED    the process was started with the attended flag
    UNATTENDED  armed from ATTENDED by a local act, for this process only
    DISARMED    was UNATTENDED, and something went wrong

**Unattended is entered, never started into.** `initial_posture` can only return
SIMULATED or ATTENDED, so a restart -- a power cut, a crash, an update -- ends
unattended operation. The agent cannot prove the mount survived whatever
restarted it, and the answer to that is somebody looking.

**DISARMED does not come back on its own.** Not on reconnect, not on a message
from the cloud, not when the fault clears. An operator restarts the agent
attended, looks, and arms again.

**Arming on real drivers is refused until a sky sensor exists.** ADR-024 §6:
nobody is at the window on an unattended node, and Phase 1 fits no sensor. The
simulator can be armed, which is how every rule here is tested.
"""

from __future__ import annotations

from contracts.models import AgentPosture, DisarmReason
from darkview_agent.config import AgentConfig


class PostureLatch:
    """Holds the posture and enforces the direction it may move in."""

    def __init__(self, initial: AgentPosture, *, real_drivers: bool) -> None:
        self._posture = initial
        self._real_drivers = real_drivers
        self._disarm_reason: DisarmReason | None = None

    @property
    def posture(self) -> AgentPosture:
        return self._posture

    @property
    def disarm_reason(self) -> DisarmReason | None:
        return self._disarm_reason

    @property
    def attended(self) -> bool:
        """Whether an operator is present, which is what the daylight override asks."""
        return self._posture is AgentPosture.attended

    @property
    def disarmed(self) -> bool:
        return self._posture is AgentPosture.disarmed

    def arm(self) -> str | None:
        """Move ATTENDED to UNATTENDED. Returns why not, or None when it did."""
        if self._posture is not AgentPosture.attended:
            return (
                f"arming is accepted only from ATTENDED, and this agent is "
                f"{self._posture.value}; restart it attended, look, and arm again"
            )
        if self._real_drivers:
            return (
                "arming on real hardware is refused until a sky sensor is fitted: "
                "nobody is at the window on an unattended node (ADR-024 §6)"
            )
        self._posture = AgentPosture.unattended
        return None

    def disarm(self, reason: DisarmReason) -> bool:
        """Move UNATTENDED to DISARMED. True if it did; nothing else is disarmable."""
        if self._posture is not AgentPosture.unattended:
            return False
        self._posture = AgentPosture.disarmed
        self._disarm_reason = reason
        return True


def initial_posture(config: AgentConfig) -> AgentPosture:
    """What a freshly started process is. Never UNATTENDED, by construction."""
    return AgentPosture.attended if config.attended else AgentPosture.simulated


__all__ = ["PostureLatch", "initial_posture"]
