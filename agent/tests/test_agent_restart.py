"""What survives the agent stopping, and what deliberately does not.

Every test here builds an agent, stops it, and builds another one against the
same state file. That is a restart: a new process, new devices, new sockets, new
clocks, and one file carrying what the last run knew.

The distinction these are about: **ownership and decisions come back, a mission
does not.** The agent can prove it already ran a command and can prove who was
holding the telescope. It cannot prove where the mount is pointing or how far a
capture had got, so it parks and tells the cloud rather than guessing.
"""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest

from contracts.models import MissionState
from tests import command_fixtures as commands
from tests.agent_harness import build_agent, hello_from, run_to


@pytest.fixture
def state_path(tmp_path):
    return tmp_path / "agent-state.sqlite3"


def restart(agent, *, keep_mount: bool = False, **kwargs):
    """Stop this agent and start another one against the same state file.

    `keep_mount` carries the telescope across, still pointing where it was. That
    is what a crash actually leaves behind: the agent process goes, the mount
    does not stop.
    """
    path = agent.store.path
    mount = agent.mount if keep_mount else None
    agent.close()
    return build_agent(state_path=path, mount=mount, **kwargs)


# ----------------------------------------------------------------------
# Decisions survive
# ----------------------------------------------------------------------


def test_a_command_already_carried_out_is_refused_after_a_restart(state_path):
    """The guarantee that gates hardware enablement.

    A retry arriving during a restart is not a strange case -- it is the ordinary
    one, because a restart is exactly when the cloud has stopped hearing acks and
    starts sending the command again. Performing the slew twice is the highest
    consequence duplicate in the system.
    """
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    goto = agent.goto()
    assert agent.command(goto)["status"] == "ACCEPTED"

    revived = restart(agent, max_altitude_degrees=70.0)
    revived.own()
    ack = revived.command(goto)

    assert ack["status"] == "DUPLICATE"
    assert ack["rejectionReason"] == "DUPLICATE_COMMAND_ID"
    assert revived.supervisor.runner.is_active is False
    assert revived.mount.status().parked is True
    revived.close()


def test_a_command_never_seen_before_is_still_accepted_after_a_restart(state_path):
    """The seen-set must refuse repeats, not everything."""
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    agent.command(agent.goto())

    revived = restart(agent, max_altitude_degrees=70.0)
    revived.own()
    ack = revived.command(revived.goto())

    assert ack["status"] == "ACCEPTED"
    revived.close()


def test_the_audit_of_a_refusal_outlives_the_process(state_path):
    """The account written by the machine that holds the telescope is worth
    keeping precisely because of the crash that makes somebody ask about it."""
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.command(agent.goto())  # refused: nobody owns the observatory yet

    revived = restart(agent, max_altitude_degrees=70.0)
    kinds = [event.kind for event in revived.store.audit_events()]
    reasons = [event.reason for event in revived.store.audit_events()]

    assert "COMMAND_REJECTED" in kinds
    assert "NO_ACTIVE_MISSION" in reasons
    revived.close()


# ----------------------------------------------------------------------
# Ownership survives
# ----------------------------------------------------------------------


def test_ownership_and_the_spent_allowance_come_back(state_path):
    """A restart that refilled the allowance would give back the drift budget
    the cumulative nudge limit exists to bound -- and rebooting the agent is not
    something a customer can do, but a flaky mini-PC is."""
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    agent.command(agent.nudge(step_arcminutes=6.0))
    spent = agent.supervisor.validator.cumulative_nudge_degrees
    assert spent == pytest.approx(0.1)

    revived = restart(agent, max_altitude_degrees=70.0)

    assert revived.supervisor.owner is not None
    assert revived.supervisor.owner.session_id == commands.SESSION_ID
    assert revived.supervisor.owner.user_id == commands.USER_ID
    assert revived.supervisor.validator.cumulative_nudge_degrees == pytest.approx(spent)
    revived.close()


def test_a_session_that_expired_while_the_agent_was_down_is_not_restored(state_path):
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own(expires_at=agent.wall.now + timedelta(minutes=5))
    agent.command(agent.goto())

    revived = restart(agent, max_altitude_degrees=70.0)
    revived.advance(600.0)

    assert revived.supervisor.owner is None
    revived.close()


def test_a_revoked_session_does_not_come_back(state_path):
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    agent.own(session_id=None)

    revived = restart(agent, max_altitude_degrees=70.0)

    assert revived.supervisor.owner is None
    ack = revived.command(revived.goto())
    assert ack["rejectionReason"] == "NO_ACTIVE_MISSION"
    revived.close()


# ----------------------------------------------------------------------
# A mission is reported, not resumed
# ----------------------------------------------------------------------


def test_a_mission_in_flight_is_parked_and_reported_rather_than_continued(state_path):
    """The agent has lost the state machine's progress -- which frame, which
    centring iteration, whether the slew had settled. Continuing from a mission
    id would be guessing about where a telescope is pointing.

    The mount is carried across still tracking, because that is what a crash
    leaves behind. A test that let the new agent build a fresh `SimMount` would
    assert `parked` against a mount that was born parked and prove nothing.
    """
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    mission_id = agent.supervisor.runner.mission_id

    abandoned = agent.mount.status()
    assert abandoned.parked is False, "the mount should still be on target"
    assert abandoned.tracking is True

    revived = restart(agent, max_altitude_degrees=70.0, keep_mount=True)

    assert revived.mount.status().parked is True
    assert revived.mount.status().tracking is False
    assert revived.supervisor.runner.is_active is False
    assert hello_from(revived)["resumeMissionId"] == mission_id
    assert [
        event for event in revived.store.audit_events() if event.kind == "MISSION_RECOVERED"
    ]
    revived.close()


def test_a_restart_with_no_mission_held_leaves_the_mount_alone(state_path):
    """Park on recovery is the answer to an abandoned mission, not to every boot.

    An agent restarted between sessions must not drive a mount an operator had
    deliberately positioned -- for a focus check, for a collimation run.
    """
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    positioned = agent.mount
    positioned.connect()
    positioned.unpark()
    positioned.slew_to(45.0, 180.0)

    revived = restart(agent, max_altitude_degrees=70.0, keep_mount=True)

    assert revived.mount.status().parked is False
    assert revived.supervisor.recovered_mission is None
    revived.close()


def test_the_recovered_mission_stops_being_reported_once_the_cloud_has_heard_it(
    state_path,
):
    """Held until the link is up, not until the hello is written.

    A restart that failed to reach the cloud must report the same mission on the
    next attempt, or the observatory quietly forgets it was holding one.
    """
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    # Comes back, cannot reach the cloud, stops again.
    offline = restart(agent, max_altitude_degrees=70.0, online=False)
    offline.pump()
    assert offline.supervisor.recovered_mission is not None

    # Comes back again and does reach the cloud.
    revived = restart(offline, max_altitude_degrees=70.0)
    assert revived.supervisor.recovered_mission is None

    once_reported = restart(revived, max_altitude_degrees=70.0)
    assert once_reported.supervisor.recovered_mission is None
    assert hello_from(once_reported)["resumeMissionId"] is None
    once_reported.close()


def test_a_finished_mission_is_not_recovered(state_path):
    """Only an unfinished mission is the cloud's to close out."""
    agent = build_agent(max_altitude_degrees=70.0, state_path=state_path)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.complete)

    revived = restart(agent, max_altitude_degrees=70.0)

    assert revived.supervisor.recovered_mission is None
    assert hello_from(revived)["resumeMissionId"] is None
    revived.close()


# ----------------------------------------------------------------------
# The safety envelope
# ----------------------------------------------------------------------


def test_the_measured_envelope_survives_a_reboot_with_no_cloud(state_path):
    """Otherwise an agent that restarted during an outage comes back UNMEASURED
    and refuses every slew -- safe, and the wrong kind of safe, because the
    limits were measured and are known."""
    agent = build_agent(max_altitude_degrees=64.0, state_path=state_path)
    agent.deliver(
        {
            "type": "CLOUD_SAFETY_ENVELOPE_UPDATE",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "envelope": _envelope_message(64.0),
        }
    )
    agent.pump()

    # Comes back knowing nothing the cloud has not told it this run.
    revived = restart(agent, max_altitude_degrees=None)

    assert hello_from(revived)["safetyEnvelopeConfigured"] is True
    revived.own()
    assert revived.command(revived.goto())["status"] == "ACCEPTED"
    revived.close()


def test_an_agent_with_no_stored_envelope_still_refuses_every_slew(state_path):
    """Nothing about recovery may turn UNMEASURED into a number."""
    agent = build_agent(max_altitude_degrees=None, state_path=state_path)
    agent.own()

    ack = agent.command(agent.goto())

    assert ack["rejectionReason"] == "SAFETY_ENVELOPE_UNMEASURED"
    assert hello_from(agent)["safetyEnvelopeConfigured"] is False
    agent.close()


def _envelope_message(max_altitude_degrees: float) -> dict:
    import json

    from tests.envelope_fixtures import build_config

    return json.loads(
        build_config(max_altitude_degrees=max_altitude_degrees).model_dump_json(
            by_alias=True
        )
    )
