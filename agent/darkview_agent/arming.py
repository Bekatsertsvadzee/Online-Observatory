"""Arm or disarm unattended operation, at the observatory (ADR-024).

    python -m darkview_agent arm-unattended --operator "Name"
    python -m darkview_agent disarm --operator "Name"

Run on the observatory machine, beside a running agent. Nothing here talks to the
agent directly -- the observatory accepts no inbound connection, not even from
itself. Each command appends a request to the agent's local state store, naming
the run it is for, and the agent acts on it at its next pass and audits what it
did.

Arming asks for an agent that is ATTENDED: started in person with the attended
flag. The agent checks again and has the final word; this command only refuses
early what it can already see will be refused.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from datetime import UTC, datetime

from contracts.models import AgentPosture
from darkview_agent.config import ConfigurationError, _state_path, resolve_environment
from darkview_agent.state.store import StateStore

ARM = "arm-unattended"
DISARM = "disarm"

USAGE = f"usage: python -m darkview_agent {{{ARM}|{DISARM}}} --operator NAME"


def run_request(
    command: str,
    operator: str,
    environment: dict[str, str],
    say: Callable[[str], None],
) -> int:
    try:
        path = _state_path(resolve_environment(environment))
    except ConfigurationError as error:
        say(str(error))
        return 2

    if not path.is_file():
        say(f"No agent state at {path}. Start the agent before arming or disarming it.")
        return 2

    store = StateStore(path, maintain=False)
    try:
        run = store.load_run()
        if run is None:
            say("The agent has not recorded a run yet. Is it running?")
            return 2

        if command == ARM and run.posture is not AgentPosture.attended:
            say(
                f"Refusing to arm: the agent is {run.posture.value}. Arming is accepted "
                "only from ATTENDED -- start it in person with DARKVIEW_AGENT_ATTENDED set, "
                "look, and arm again."
            )
            return 1

        action = "ARM" if command == ARM else "DISARM"
        store.append_posture_request(run.run_id, action, operator, datetime.now(UTC))
    finally:
        store.close()

    say(
        f"{action} requested for run {run.run_id} by {operator}. The agent acts on it at "
        "its next pass and records the outcome in its audit log."
    )
    return 0


def main(command: str, arguments: list[str]) -> int:
    if len(arguments) != 2 or arguments[0] != "--operator" or not arguments[1].strip():
        print(USAGE, file=sys.stderr)
        return 2
    return run_request(command, arguments[1].strip(), dict(os.environ), print)
