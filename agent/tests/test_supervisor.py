"""The chain: cloud command -> link -> validator -> runner -> SimMount.

Every piece of this was already tested on its own and none of it was connected.
These tests exist to prove the connection, so they are deliberately end-to-end
within the agent: a message goes into a fake socket and a simulated telescope
moves, or a refusal comes back out of the same socket.

Two of them are the reason `docs/backlog.md` recorded a debt against DV-026.
`test_a_nudge_is_judged_on_where_it_would_land` and
`test_the_daylight_lock_answers_to_the_local_attended_flag` fail if the
supervisor stops passing `pointing` or `attended` to the validator, and a unit
test of the validator passes either way.
"""

from __future__ import annotations

import json
from datetime import timedelta
from uuid import uuid4

import pytest

from contracts.models import MissionState
from darkview_agent.devices.base import DeviceError
from darkview_agent.link.session import MAX_CLOCK_CORRECTION_SECONDS
from darkview_agent.safety.coordinates import equatorial_to_horizontal
from tests import command_fixtures as commands
from tests.agent_harness import (
    DAYLIGHT_DEC_DEGREES,
    DAYLIGHT_RA_HOURS,
    NOON,
    TARGET_ALTITUDE,
    TARGET_DEC_DEGREES,
    TARGET_RA_HOURS,
    build_agent,
    hello_from,
    run_to,
)
from tests.envelope_fixtures import TBILISI, build_config

# ----------------------------------------------------------------------
# The chain
# ----------------------------------------------------------------------


def test_a_goto_command_moves_the_simulated_mount():
    """Milestone S1's claim, in one test: API -> WSS -> agent -> SimMount.

    Nothing here reaches around the chain. The GOTO arrives as a frame on the
    socket and the assertion is on the mount, not on any intermediate object.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    ack = agent.command(agent.goto())

    assert ack is not None
    assert ack["status"] == "ACCEPTED"
    assert agent.supervisor.runner.state is MissionState.slewing
    assert agent.mount.status().slewing is True
    assert agent.mount.status().parked is False


def test_a_mission_runs_from_a_goto_all_the_way_to_a_parked_mount():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())

    run_to(agent, MissionState.complete)

    assert agent.supervisor.runner.frames_captured == 10
    assert agent.mount.status().parked is True

    states = [event["state"] for event in agent.events()]
    assert states[0] == "PREPARING"
    assert states[-1] == "COMPLETE"
    assert "OBSERVING" in states and "CAPTURING" in states


def test_a_command_arriving_with_no_session_owner_is_refused():
    """The agent holds nothing until the cloud says who owns it."""
    agent = build_agent(max_altitude_degrees=70.0)

    ack = agent.command(agent.goto())

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "NO_ACTIVE_MISSION"
    assert agent.mount.status().parked is True
    assert agent.supervisor.runner.is_active is False


def test_a_command_from_another_session_is_refused():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    ack = agent.command(agent.goto(session_id=uuid4()))

    assert ack["rejectionReason"] == "WRONG_SESSION"
    assert agent.supervisor.runner.is_active is False


# ----------------------------------------------------------------------
# The wiring DV-026 owed
# ----------------------------------------------------------------------


def test_a_nudge_is_judged_on_where_it_would_land():
    """Issue #12, proved through the runner rather than against the validator.

    The mount sits at altitude 56.662 and MAX_ALT_SAFE is 57. A 30-arcminute step
    is within every relative limit -- half the per-step ceiling, a quarter of the
    cumulative one -- and still lands at 57.162, outside the envelope. Only a
    validator that was actually handed the mount's position can see that, which
    is what makes this test the evidence that `pointing` is wired.
    """
    agent = build_agent(max_altitude_degrees=57.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    settled = agent.mount.status()
    assert settled.slewing is False
    assert settled.altitude_degrees == pytest.approx(TARGET_ALTITUDE, abs=0.01)

    ack = agent.command(agent.nudge(step_arcminutes=30.0))

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "SAFETY_ABOVE_MAX_ALTITUDE"
    assert agent.mount.status().altitude_degrees == pytest.approx(TARGET_ALTITUDE, abs=0.01)


def test_a_nudge_within_the_envelope_moves_the_mount():
    agent = build_agent(max_altitude_degrees=57.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    before = agent.mount.status().altitude_degrees
    ack = agent.command(agent.nudge(step_arcminutes=6.0))
    agent.advance(5.0)

    assert ack["status"] == "ACCEPTED"
    assert agent.mount.status().altitude_degrees == pytest.approx(before + 0.1, abs=0.01)


def test_a_second_nudge_is_refused_while_the_first_is_still_moving():
    """Where "wherever it is now" is a range rather than a position.

    Two nudges in quick succession is how a customer actually produces this: the
    second arrives while the mount is still travelling, and the position it would
    be judged against has not happened yet.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    accepted = agent.command(agent.nudge(step_arcminutes=6.0))
    assert accepted["status"] == "ACCEPTED"
    assert agent.mount.status().slewing is True

    ack = agent.command(agent.nudge(step_arcminutes=6.0))

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "DEVICE_UNAVAILABLE"
    assert "slewing" in ack["detail"]


def test_the_daylight_lock_answers_to_the_local_attended_flag():
    """Issue #10, through the chain. The cloud's operator claim is not enough."""
    unattended = build_agent(max_altitude_degrees=70.0, attended=False, start=NOON)
    unattended.own()
    ack = unattended.command(
        unattended.goto(
            ra_hours=DAYLIGHT_RA_HOURS,
            dec_degrees=DAYLIGHT_DEC_DEGREES,
            issued_by_operator_id=uuid4(),
            override_reason="terrestrial focus check",
        )
    )

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "SAFETY_DAYLIGHT_LOCK"
    assert unattended.mount.status().parked is True


def test_an_attended_operator_may_lift_the_daylight_lock():
    attended = build_agent(max_altitude_degrees=70.0, attended=True, start=NOON)
    attended.own()

    ack = attended.command(
        attended.goto(
            ra_hours=DAYLIGHT_RA_HOURS,
            dec_degrees=DAYLIGHT_DEC_DEGREES,
            issued_by_operator_id=uuid4(),
            override_reason="terrestrial focus check",
        )
    )

    assert ack["status"] == "ACCEPTED"
    assert attended.mount.status().slewing is True


def test_an_unattended_agent_refuses_even_a_command_the_cloud_signed_as_operator():
    """The daylight lock is the visible case; the rule is broader.

    `issuedByOperatorId` is a claim made by the cloud. An agent that trusted it
    would let a compromised cloud move the mount in daylight with nobody at the
    observatory, which is the exact scenario the second validation exists for.
    """
    agent = build_agent(max_altitude_degrees=70.0, attended=False, start=NOON)
    agent.own()
    agent.command(
        agent.goto(
            ra_hours=DAYLIGHT_RA_HOURS,
            dec_degrees=DAYLIGHT_DEC_DEGREES,
            issued_by_operator_id=uuid4(),
            override_reason="claimed by the cloud",
        )
    )
    assert agent.supervisor.runner.is_active is False


# ----------------------------------------------------------------------
# Ownership
# ----------------------------------------------------------------------


def test_a_session_update_without_a_user_grants_nothing():
    """Half an owner is not an owner. The envelope check compares userId."""
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own(user_id=None)

    assert agent.supervisor.owner is None
    ack = agent.command(agent.goto())
    assert ack["rejectionReason"] == "NO_ACTIVE_MISSION"


def test_revoking_a_session_stops_every_further_command():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    assert agent.supervisor.runner.is_active is True

    agent.own(session_id=None)

    assert agent.supervisor.owner is None
    ack = agent.command(agent.nudge())
    assert ack["rejectionReason"] == "NO_ACTIVE_MISSION"


def test_re_asserting_the_same_session_keeps_the_nudge_allowance():
    """The cloud replays the current session. It must not refill the allowance.

    Load-bearing, because the realtime service sweeps -- and so re-asserts
    ownership -- often. If an unchanged session reset the offset, the cumulative
    nudge limit would be refilled continuously and would bound nothing at all:
    the booked target could be walked off frame one permitted step at a time.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    agent.command(agent.nudge(step_arcminutes=6.0))

    spent = agent.supervisor.validator.cumulative_nudge_degrees
    assert spent == pytest.approx(0.1)

    agent.own()  # the same mission, session and user

    assert agent.supervisor.validator.cumulative_nudge_degrees == pytest.approx(spent)


def test_a_new_session_starts_with_a_fresh_allowance():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    agent.command(agent.nudge(step_arcminutes=6.0))
    assert agent.supervisor.validator.cumulative_nudge_degrees > 0

    agent.own(session_id=uuid4())

    assert agent.supervisor.validator.cumulative_nudge_degrees == 0.0


def test_a_lapsed_session_loses_the_telescope_without_the_cloud_saying_so():
    """The cloud revokes expired sessions. This is the second check.

    A cloud that has stopped talking must not leave a customer holding the
    telescope past the slot they paid for.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own(expires_at=agent.wall.now + timedelta(seconds=30))
    agent.command(agent.goto())
    assert agent.supervisor.owner is not None

    agent.advance(60.0)

    assert agent.supervisor.owner is None
    assert [
        event for event in agent.supervisor.audit.events() if event.kind == "SESSION_EXPIRED"
    ]


def test_a_session_update_the_agent_cannot_read_clears_ownership():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    assert agent.supervisor.owner is not None

    agent.deliver(
        {
            "type": "CLOUD_SESSION_UPDATE",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "missionId": "not-a-uuid",
            "sessionId": str(commands.SESSION_ID),
            "userId": str(commands.USER_ID),
        }
    )
    agent.pump()

    assert agent.supervisor.owner is None


# ----------------------------------------------------------------------
# What the observatory cannot do
# ----------------------------------------------------------------------


def test_a_second_mission_is_refused_rather_than_queued():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    first = agent.supervisor.runner.mission_id

    other_mission, other_session = uuid4(), uuid4()
    agent.own(mission_id=other_mission, session_id=other_session)
    ack = agent.command(
        agent.goto(mission_id=other_mission, session_id=other_session)
    )

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "MISSION_ALREADY_ACTIVE"
    assert agent.supervisor.runner.mission_id == first


@pytest.mark.parametrize(
    ("command_type", "payload", "owed_to"),
    [
        (
            "SET_PROFILE",
            {"kind": "SET_PROFILE", "imagingProfile": "LUNAR"},
            "DV-033",
        ),
    ],
)
def test_a_command_this_build_cannot_perform_is_refused_not_silently_accepted(
    command_type, payload, owed_to
):
    """An ACCEPTED ack for a command nothing performs is a lie the cloud believes.

    The customer would be shown a capture that was never taken. Refusing, and
    naming the issue that will implement it, is the honest answer until then.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())

    ack = agent.command(
        commands.envelope(
            command_type=command_type, payload=payload, issued_at=agent.wall.now
        )
    )

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "DEVICE_UNAVAILABLE"
    assert owed_to in ack["detail"]


def _focus(agent, mode: str = "AUTOFOCUS", position: int | None = None) -> dict:
    payload = {"kind": "FOCUS", "mode": mode, "absolutePosition": position}
    return agent.command(
        commands.envelope(command_type="FOCUS", payload=payload, issued_at=agent.wall.now)
    )


def test_an_absolute_focus_while_observing_moves_the_focuser_and_holds_the_mission():
    """DV-031. The observation does not time out from under a focuser still moving."""
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)

    ack = _focus(agent, "ABSOLUTE", 22000)
    assert ack["status"] == "ACCEPTED"

    # Seven thousand steps is several seconds of travel; observing_seconds is 4.
    agent.advance(4.0)
    assert agent.devices.focuser.status().moving is True
    assert agent.supervisor.runner.state is MissionState.observing

    run_to(agent, MissionState.capturing)
    assert agent.devices.focuser.status().position == 22000


def test_an_inward_absolute_focus_ends_travelling_outward():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)
    moves: list[int] = []
    original = agent.devices.focuser.move_to
    agent.devices.focuser.move_to = lambda position: (moves.append(position), original(position))

    _focus(agent, "ABSOLUTE", 12000)
    run_to(agent, MissionState.capturing)

    assert moves[-1] == 12000
    assert moves[-2] < 12000


def test_autofocus_while_observing_is_accepted_and_finishes_before_capturing():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)

    ack = _focus(agent)
    assert ack["status"] == "ACCEPTED"
    assert any(event.kind == "FOCUS_REQUESTED" for event in agent.supervisor.audit.events())

    run_to(agent, MissionState.capturing, budget_seconds=600.0)
    assert agent.devices.focuser.status().moving is False


def test_focus_with_no_mission_running_is_refused():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    ack = _focus(agent)

    assert ack["rejectionReason"] == "NO_ACTIVE_MISSION"


def test_focus_outside_observing_is_refused():
    """Before OBSERVING the plate solver owns the camera; after it the capture run does."""
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())

    ack = _focus(agent, "ABSOLUTE", 16000)

    assert ack["rejectionReason"] == "DEVICE_UNAVAILABLE"
    assert "observing" in ack["detail"]


@pytest.mark.parametrize("position", [None, -1, 30001])
def test_an_absolute_focus_without_a_position_in_travel_is_refused(position):
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)

    ack = _focus(agent, "ABSOLUTE", position)

    assert ack["status"] == "REJECTED"
    assert agent.devices.focuser.status().moving is False


def test_a_second_focus_while_one_runs_is_refused():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)
    _focus(agent, "ABSOLUTE", 22000)

    ack = _focus(agent, "ABSOLUTE", 10000)

    assert ack["rejectionReason"] == "DEVICE_UNAVAILABLE"
    assert "already in progress" in ack["detail"]


def test_abort_during_a_focus_stops_the_focuser_and_parks():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.observing)
    _focus(agent, "ABSOLUTE", 29000)
    agent.advance(1.0)
    assert agent.devices.focuser.status().moving is True

    agent.command(commands.abort(issued_at=agent.wall.now))

    assert agent.devices.focuser.status().moving is False
    assert agent.mount.status().parked is True


def test_a_recentring_goto_with_no_mission_running_is_refused():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    ack = agent.command(agent.goto(recenter=True))

    assert ack["rejectionReason"] == "NO_ACTIVE_MISSION"
    assert agent.supervisor.runner.is_active is False


def test_a_recentring_goto_returns_the_customer_s_allowance():
    """Recentring undoes the drift the allowance was measuring.

    Without this the recentre control takes a customer's remaining nudges away
    instead of giving them back, and a session ends unable to move at all.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    agent.command(agent.nudge(step_arcminutes=6.0))
    agent.advance(5.0)
    assert agent.supervisor.validator.cumulative_nudge_degrees > 0

    # Where the booked target is *now*. The sky has moved since the mission
    # started, so the recentring slew goes to the current position, not the one
    # the first GOTO used.
    on_target = equatorial_to_horizontal(
        TARGET_RA_HOURS, TARGET_DEC_DEGREES, agent.wall.now, TBILISI
    )
    nudged_to = agent.mount.status().altitude_degrees
    assert nudged_to != pytest.approx(on_target.altitude_degrees, abs=0.05)

    ack = agent.command(agent.goto(recenter=True))
    agent.advance(10.0)

    assert ack["status"] == "ACCEPTED"
    assert agent.supervisor.validator.cumulative_nudge_degrees == 0.0
    assert agent.mount.status().altitude_degrees == pytest.approx(
        on_target.altitude_degrees, abs=0.05
    )


# ----------------------------------------------------------------------
# Stopping
# ----------------------------------------------------------------------


def test_abort_stops_the_mission_and_parks():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    ack = agent.command(commands.abort(issued_at=agent.wall.now))

    assert ack["status"] == "ACCEPTED"
    assert agent.supervisor.runner.state is MissionState.cancelled
    assert agent.mount.status().parked is True
    assert agent.supervisor.watchdog.parked is True


def test_park_parks_the_mount_when_no_mission_is_running():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    ack = agent.command(commands.park(issued_at=agent.wall.now))

    assert ack["status"] == "ACCEPTED"
    assert agent.mount.status().parked is True


def test_park_ends_a_running_mission():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    agent.command(commands.park(issued_at=agent.wall.now))

    assert agent.supervisor.runner.is_active is False
    assert agent.mount.status().parked is True


def test_a_repeated_command_does_not_touch_the_mount_twice():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    nudge = agent.nudge(step_arcminutes=6.0)
    agent.command(nudge)
    agent.advance(5.0)
    moved_to = agent.mount.status().altitude_degrees

    ack = agent.command(nudge)
    agent.advance(5.0)

    assert ack["status"] == "DUPLICATE"
    assert agent.mount.status().altitude_degrees == pytest.approx(moved_to, abs=0.001)


def test_a_device_fault_during_execution_parks_the_mount():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)

    def refuse(*_args, **_kwargs):
        raise DeviceError("mount stopped answering")

    agent.mount.slew_to = refuse  # type: ignore[method-assign]

    ack = agent.command(agent.nudge(step_arcminutes=6.0))

    assert ack["status"] == "REJECTED"
    assert ack["rejectionReason"] == "DEVICE_UNAVAILABLE"
    assert agent.supervisor.watchdog.parked is True


# ----------------------------------------------------------------------
# The link
# ----------------------------------------------------------------------


def test_an_unreadable_command_is_not_acked():
    """AgentCommandAck.commandId is a uuid. An ack naming nothing fails the
    cloud's own schema and correlates with no command, so there is nothing to
    send -- the refusal lives in the audit log."""
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    agent.deliver(
        {
            "type": "CLOUD_COMMAND",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "command": {"commandId": "not-a-uuid", "type": "PARK"},
        }
    )
    agent.pump()

    assert agent.acks() == []
    assert [
        event for event in agent.supervisor.audit.events() if event.kind == "COMMAND_REJECTED"
    ]


def test_a_safety_envelope_update_reaches_everything_that_enforces_it():
    """One message, four things that have to change together.

    The validator refuses commands against it, the runner admits missions against
    it, the watchdog reads its two timeouts from it, and the link reports whether
    it is measured at all so the cloud will not schedule against an observatory
    that cannot move.
    """
    agent = build_agent(max_altitude_degrees=None)
    assert hello_from(agent)["safetyEnvelopeConfigured"] is False

    measured = build_config(max_altitude_degrees=64.0)
    agent.deliver(
        {
            "type": "CLOUD_SAFETY_ENVELOPE_UPDATE",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "envelope": json.loads(measured.model_dump_json(by_alias=True)),
        }
    )
    agent.pump()

    assert agent.supervisor.watchdog.link_dead_seconds == float(measured.link_dead_seconds)

    # The link reports it at the next hello, which is the only place it is read.
    agent.connector.current.kill()
    agent.advance(2.0, steps=4)
    assert hello_from(agent)["safetyEnvelopeConfigured"] is True

    agent.connector.current.deliver_welcome(server_time=agent.wall.now)
    agent.pump()
    agent.own()
    ack = agent.command(agent.goto())
    assert ack["status"] == "ACCEPTED"


def test_an_unmeasured_envelope_refuses_every_slew():
    """MAX_ALT_SAFE null means UNMEASURED, and unmeasured means nothing moves."""
    agent = build_agent(max_altitude_degrees=None)
    agent.own()

    ack = agent.command(agent.goto())

    assert ack["rejectionReason"] == "SAFETY_ENVELOPE_UNMEASURED"
    assert agent.mount.status().parked is True


def test_an_unreadable_envelope_update_leaves_the_previous_limits_in_force():
    """Discarding an envelope on a bad update would relax the limits."""
    agent = build_agent(max_altitude_degrees=57.0)
    agent.deliver(
        {
            "type": "CLOUD_SAFETY_ENVELOPE_UPDATE",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "envelope": {"observatoryId": "nonsense"},
        }
    )
    agent.pump()

    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    ack = agent.command(agent.nudge(step_arcminutes=30.0))

    assert ack["rejectionReason"] == "SAFETY_ABOVE_MAX_ALTITUDE"


def test_a_fatal_cloud_error_drops_the_link_and_re_dials():
    agent = build_agent(max_altitude_degrees=70.0)
    assert agent.supervisor.link.is_online is True
    attempts = agent.connector.attempts

    agent.deliver(
        {
            "type": "CLOUD_ERROR",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "code": "INTERNAL",
            "message": "the cloud is unwell",
            "fatal": True,
        }
    )
    agent.pump()
    assert agent.supervisor.link.is_online is False

    agent.advance(5.0)
    assert agent.connector.attempts > attempts


def test_a_non_fatal_cloud_error_keeps_the_link():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.deliver(
        {
            "type": "CLOUD_ERROR",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "code": "INTERNAL",
            "message": "a passing complaint",
            "fatal": False,
        }
    )
    agent.pump()

    assert agent.supervisor.link.is_online is True


def test_an_agent_that_reconnects_mid_mission_says_which_mission_it_holds():
    """A reconnecting agent that reported nothing would look like an idle
    observatory, and the cloud would schedule against a telescope in use."""
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    mission_id = agent.supervisor.runner.mission_id

    agent.connector.current.kill()
    agent.advance(2.0, steps=4)

    assert hello_from(agent)["resumeMissionId"] == mission_id


def test_an_unrecognised_message_is_ignored_rather_than_fatal():
    agent = build_agent(max_altitude_degrees=70.0)
    agent.deliver({"type": "CLOUD_SOMETHING_NEW", "messageId": str(uuid4())})
    agent.pump()

    assert agent.supervisor.link.is_online is True


def test_mission_events_are_sent_outside_the_device_lock():
    """A telescope must never wait on a socket to be parked.

    The runner appends its transitions to an outbox and the supervisor drains it
    after releasing the watchdog's device lock. Sending inline would mean a slow
    or half-dead connection holding the lock a Park needs, in exactly the
    conditions -- a failing network -- where a Park is most likely to be due.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    lock = agent.supervisor.watchdog.device_lock
    held_during_send: list[bool] = []
    original = agent.supervisor.link.send

    def record_whether_the_lock_is_held(message):
        # `_is_owned()` and not `acquire(blocking=False)`: the lock is an RLock,
        # so this thread can always re-acquire one it already holds, and a test
        # written that way would pass whether or not the send was inside it.
        held_during_send.append(lock._is_owned())
        return original(message)

    agent.supervisor.link.send = record_whether_the_lock_is_held  # type: ignore[method-assign]

    agent.command(agent.goto())
    run_to(agent, MissionState.complete)

    assert agent.events(), "the mission produced no events to check"
    assert held_during_send, "nothing was sent, so nothing was checked"
    assert not any(held_during_send)


# ----------------------------------------------------------------------
# The watchdog and the runner, joined
# ----------------------------------------------------------------------


def test_a_link_dead_park_ends_the_mission_and_the_mount_stays_parked():
    """A watchdog Park is the end of the mission, not an interruption of it.

    Before this test the runner had no view of the watchdog: it kept driving the
    state machine after the Park, and its next slew took the mount straight back
    out of Park with no link to anyone.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.slewing)

    agent.connector.current.kill()
    # No welcome is delivered on the redial, so the link stays down.
    agent.advance(61.0, steps=4)
    action = agent.supervisor.watchdog.evaluate()
    assert action is not None and action.parked is True

    agent.pump()

    assert agent.supervisor.runner.is_active is False
    assert agent.supervisor.runner.state is MissionState.cancelled
    assert agent.supervisor.runner.failure_reason.value == "AGENT_LINK_LOST"

    # Nothing the runner does afterwards moves the mount.
    agent.advance(120.0, steps=20)
    assert agent.mount.status().parked is True
    assert agent.mount.status().slewing is False


def test_a_heartbeat_blip_costs_one_exposure_not_the_mission():
    """The watchdog aborts the exposure at the heartbeat threshold and the link
    comes back before the link-dead threshold. The mission must carry on.

    Before this test the runner waited for the aborted exposure to complete,
    which it never does, so a fifteen-second blip during CAPTURING left the
    mission there for the rest of the night with the mount tracking.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()
    agent.command(agent.goto())
    run_to(agent, MissionState.capturing)
    assert agent.supervisor.runner.is_active

    agent.connector.current.kill()
    agent.pump()  # the exposure starts; the dead socket is noticed
    assert agent.devices.camera.status().exposing is True

    # Fifteen seconds in which the main loop makes no pass. The watchdog thread
    # acts alone, as it would in the process.
    agent.clock.advance(16.0)
    agent.wall.advance(16.0)
    action = agent.supervisor.watchdog.evaluate()
    assert action is not None
    assert action.stopped_capture is True and action.parked is False
    assert agent.devices.camera.status().exposing is False

    # Held, not failed, and no exposure is started while the link is down.
    agent.advance(4.0, steps=2)
    assert agent.supervisor.runner.state is MissionState.capturing
    assert agent.devices.camera.status().exposing is False

    # The link returns on the redialled socket.
    agent.connector.current.deliver_welcome(server_time=agent.wall.now)
    agent.pump()
    assert agent.supervisor.link.is_online is True

    run_to(agent, MissionState.complete)
    assert agent.mount.status().parked is True


def test_live_frames_are_sent_outside_the_device_lock():
    """The same rule as mission events, for the frames.

    A live frame is encoded to JPEG and written to the socket. Both used to
    happen inside the runner's pump, under the watchdog's device lock, so a
    congested uplink could hold the lock a Park needs.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    lock = agent.supervisor.watchdog.device_lock
    held_during_send: list[bool] = []
    transport = agent.connector.current
    original = transport.send_binary

    def record_whether_the_lock_is_held(payload):
        held_during_send.append(lock._is_owned())
        return original(payload)

    transport.send_binary = record_whether_the_lock_is_held  # type: ignore[method-assign]

    agent.command(agent.goto())
    run_to(agent, MissionState.complete)

    assert held_during_send, "no live frame was sent, so nothing was checked"
    assert not any(held_during_send)


# ----------------------------------------------------------------------
# The two clocks
# ----------------------------------------------------------------------


def test_an_agent_whose_clock_ran_ahead_still_accepts_fresh_commands():
    """`expiresAt` is stamped by the cloud and compared here against a mini-PC in
    a garden. Until the agent read the cloud's own time, a few minutes of drift
    meant every command the cloud sent was refused as COMMAND_EXPIRED -- and from
    the cloud that is indistinguishable from an observatory that has stopped
    working.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    cloud_now = agent.wall.now
    agent.wall.now = cloud_now + timedelta(minutes=10)
    agent.own()

    ack = agent.command(commands.envelope(command_type="PARK", issued_at=cloud_now))

    assert ack["status"] == "ACCEPTED", ack
    agent.close()


def test_a_command_the_cloud_queued_for_too_long_is_still_expired():
    """The correction is for the clocks disagreeing, not for a stale command.

    `sentAt` is when the cloud sent the message, so a command it issued ten
    minutes earlier and only sent now arrives visibly old however well the clocks
    agree. That is the case expiry exists for and it must survive the fix.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    agent.own()

    ack = agent.command(
        commands.envelope(
            command_type="PARK", issued_at=agent.wall.now - timedelta(minutes=10)
        ),
        sent_at=agent.wall.now,
    )

    assert ack["status"] == "EXPIRED", ack
    agent.close()


def test_the_correction_is_bounded():
    """A cloud that names a time far in the past would otherwise hold every
    command it has ever issued open. It moves the agent by fifteen minutes at
    most, and says so."""
    agent = build_agent(max_altitude_degrees=70.0)
    agent.deliver(
        {
            "type": "CLOUD_SESSION_UPDATE",
            "messageId": str(uuid4()),
            "sentAt": (agent.wall.now - timedelta(days=30)).isoformat(),
            "missionId": None,
            "sessionId": None,
            "userId": None,
            "expiresAt": None,
        }
    )
    agent.pump()

    assert agent.supervisor.link.clock_correction == -timedelta(
        seconds=MAX_CLOCK_CORRECTION_SECONDS
    )
    agent.close()
