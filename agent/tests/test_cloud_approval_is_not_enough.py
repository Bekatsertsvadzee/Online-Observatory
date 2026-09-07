"""DV-059 criterion 5 — cloud approval never lets the agent skip its own check.

`CLAUDE.md`: "The cloud validates commands; the local agent validates them again.
A cloud-approved command that fails local safety is refused."

DV-059 gave the cloud the first of those two checks. The risk it introduces is
subtle and worth stating: once a command has been examined once, the second
examination starts to look like duplicated work, and duplicated work gets removed.
It must not be. These tests fail if the agent ever starts trusting that a command
which reached it had already been judged.

The strongest case is not a compromised cloud. It is an honest one that cannot
possibly know enough: the cloud bounds a nudge by its step size, because the
cumulative offset belongs to the mount, and the mount is at the observatory. A
nudge inside every limit the cloud can see still lands where only the agent can
look.
"""

from __future__ import annotations

import pytest

from contracts.models import MissionState
from tests.agent_harness import TARGET_ALTITUDE, build_agent, run_to

# What the cloud would have been enforcing: the same envelope, since the cloud is
# where the measurement is recorded and the agent is sent a copy of it.
MEASURED_MAX_ALTITUDE = 57.0
NUDGE_RATE_DEGREES = 0.5
NUDGE_MAX_DEGREES = 2.0

# 30 arcminutes is 0.5 degrees: exactly the per-step ceiling, so it is the largest
# step the cloud's rule permits rather than a step it would have caught.
STEP_ARCMINUTES = 30.0


def _cloud_would_permit(step_arcminutes: float) -> bool:
    """The cloud's nudge rule, restated here so the claim is checked, not asserted.

    `apps/api/src/lib/safety/envelope.ts` `evaluateNudgeStep`: the envelope must be
    measured, the step must not be negative, and it must be within both the
    per-step rate and the cumulative ceiling. That is everything the cloud has to
    go on -- there is no term here for where the telescope is pointing, because
    the cloud does not know and must not guess.
    """
    step_degrees = step_arcminutes / 60.0
    measured = MEASURED_MAX_ALTITUDE is not None
    return (
        measured
        and step_degrees >= 0
        and step_degrees <= NUDGE_RATE_DEGREES
        and step_degrees <= NUDGE_MAX_DEGREES
    )


def test_the_cloud_would_have_approved_this_nudge():
    """The premise of the test below, checked rather than assumed."""
    assert _cloud_would_permit(STEP_ARCMINUTES) is True


def test_the_agent_refuses_a_nudge_the_cloud_had_no_way_to_judge():
    """A step the cloud permits, landing where only the agent can see.

    The mount settles at 56.662. The step is half a degree, which is inside the
    per-step ceiling and a quarter of the cumulative one, so every number the
    cloud holds says yes. It lands at 57.162, above a MAX_ALT_SAFE of 57.0, and
    the only party that can know that is the one holding the telescope.
    """
    agent = build_agent(
        max_altitude_degrees=MEASURED_MAX_ALTITUDE,
        nudge_max_degrees=NUDGE_MAX_DEGREES,
        nudge_rate_degrees_per_second=NUDGE_RATE_DEGREES,
    )
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    settled = agent.mount.status()
    assert settled.altitude_degrees == pytest.approx(TARGET_ALTITUDE, abs=0.01)

    ack = agent.command(agent.nudge(step_arcminutes=STEP_ARCMINUTES))

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "SAFETY_ABOVE_MAX_ALTITUDE"
    # Refused, not merely reported: the telescope did not move.
    assert agent.mount.status().altitude_degrees == pytest.approx(
        TARGET_ALTITUDE, abs=0.01
    )


def test_the_agent_refuses_a_slew_the_cloud_could_have_minted_before_measurement():
    """An UNMEASURED agent refuses even a command minted while the cloud thought
    it was measured.

    The two copies of the envelope are not updated in the same instant. A command
    minted a moment before an operator cleared MAX_ALT_SAFE is a command the cloud
    approved against numbers the agent no longer holds -- and the agent's copy is
    the one the telescope obeys.
    """
    agent = build_agent(max_altitude_degrees=None)
    agent.own()

    ack = agent.command(agent.goto())

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "SAFETY_ENVELOPE_UNMEASURED"
    assert agent.mount.status().slewing is False


def test_a_well_formed_envelope_is_not_a_permission():
    """Nothing about being minted by the cloud makes a command safe.

    The envelope here is valid in every respect the cloud controls: a real
    commandId, the current session, the owning user, an unexpired window. It is
    refused anyway, on a number the cloud never sees.
    """
    agent = build_agent(max_altitude_degrees=30.0)
    agent.own()

    envelope = agent.goto()
    assert envelope["commandId"]
    assert envelope["sessionId"]
    assert envelope["userId"]

    ack = agent.command(envelope)

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "SAFETY_ABOVE_MAX_ALTITUDE"
