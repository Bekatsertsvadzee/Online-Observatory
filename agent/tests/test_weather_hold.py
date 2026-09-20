"""The operator's weather hold, enforced at the observatory (DV-039).

The cloud has always been able to refuse the next mission when an operator calls
the sky unsafe. What it could not do was tell the observatory, so a hold lived
entirely in a process the observatory cannot see -- and an agent that lost its
link during one had nothing telling it to stay parked.

`CLOUD_WEATHER_UPDATE` is that telling. These tests are about what the agent does
with it afterwards, which is the half that matters: it holds the state, it keeps
refusing on its own, and it still refuses after a restart with no cloud in
reach.

Simulator only, like every other test here.
"""

from __future__ import annotations

from contracts.models import MissionState
from tests.agent_harness import OBSERVATORY_ID, build_agent


def _hold(agent, **kwargs) -> None:
    """Declare a hold and let the watchdog act on it.

    `evaluate` is called by hand because the watchdog thread is not running in
    these tests -- the same way the link-dead tests drive it.
    """
    agent.weather(hold_active=True, **kwargs)
    agent.supervisor.watchdog.evaluate()
    agent.pump()


def test_a_hold_refuses_a_goto_the_cloud_approved():
    """The cloud minted this command before the operator closed the sky. The
    agent has the later word and refuses it."""
    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.own()
        _hold(agent, note="cloud in from the west")

        ack = agent.command(agent.goto())
        assert ack is not None
        assert ack["status"] == "REJECTED"
        assert ack["rejectionReason"] == "WEATHER_HOLD_ACTIVE"
    finally:
        agent.close()


def test_a_hold_does_not_refuse_the_park_that_gets_out_of_it():
    """PARK and ABORT are how a telescope leaves bad weather. Refusing them for
    bad weather would be circular, and would leave a mount tracking under the
    sky an operator has just called unsafe."""
    from tests import command_fixtures as commands

    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.own()
        _hold(agent)

        ack = agent.command(commands.envelope(command_type="PARK", issued_at=agent.wall.now))
        assert ack is not None and ack["status"] == "ACCEPTED", ack
    finally:
        agent.close()


def test_a_hold_parks_the_mount_and_ends_the_running_mission_as_weather():
    """The mission the customer is watching ends, and it ends saying why.

    Before DV-039 the agent obeyed the cloud's Park and filed it as an operator
    abort, because a Park carries no reason. The cloud's record said weather and
    the observatory's did not.
    """
    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.own()
        agent.command(agent.goto())
        agent.advance(5.0, steps=5)
        assert agent.supervisor.runner.is_active

        _hold(agent)

        assert agent.mount.status().parked is True
        assert agent.supervisor.runner.state is MissionState.cancelled
        assert agent.supervisor.runner.failure_reason.value == "WEATHER_UNSAFE"
    finally:
        agent.close()


def test_clearing_the_hold_lets_the_next_command_through():
    """A hold is not terminal. The observatory has to be told the sky reopened,
    or it stays shut until it next reconnects."""
    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.own()
        _hold(agent)
        agent.weather(hold_active=False, status="CLEAR")

        ack = agent.command(agent.goto())
        assert ack is not None and ack["status"] == "ACCEPTED", ack
    finally:
        agent.close()


def test_repeating_a_hold_does_not_park_again():
    """The cloud re-sends the weather on every reconnect, and an operator may
    save an active hold again with a new note. One Park, one audit row."""
    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.own()
        _hold(agent)
        before = len(agent.supervisor.watchdog.actions)

        agent.weather(hold_active=True, note="still closed")
        agent.supervisor.watchdog.evaluate()
        agent.pump()

        assert len(agent.supervisor.watchdog.actions) == before
    finally:
        agent.close()


def test_the_hold_survives_a_restart_with_no_cloud_in_reach(tmp_path):
    """The point of the whole exercise.

    The agent restarts into an outage: no welcome, nothing from the cloud. It
    still refuses, because the hold is in its own store rather than in a message
    it has to be re-sent.
    """
    path = tmp_path / "agent-state.sqlite3"
    agent = build_agent(max_altitude_degrees=70.0, state_path=path)
    try:
        agent.own()
        _hold(agent)
    finally:
        agent.close()

    revived = build_agent(max_altitude_degrees=70.0, state_path=path, online=False)
    try:
        assert revived.supervisor.validator.weather_hold is True
        assert revived.supervisor.weather is not None
        assert revived.supervisor.weather.hold_active is True
    finally:
        revived.close()


def test_an_unreadable_weather_update_leaves_the_hold_standing():
    """Failing open here would lift a hold, which is the wrong direction. The
    previous state stays in force, exactly as an unreadable envelope does."""
    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.own()
        _hold(agent)

        agent.deliver(
            {
                "type": "CLOUD_WEATHER_UPDATE",
                "messageId": "not-a-uuid-but-the-weather-is-the-point",
                "sentAt": agent.wall.now.isoformat(),
                "observatoryId": str(OBSERVATORY_ID),
                "weather": {"holdActive": False},
            }
        )
        agent.pump()

        assert agent.supervisor.validator.weather_hold is True
    finally:
        agent.close()


def test_weather_for_another_observatory_is_discarded():
    """Nothing should ever send it, and acting on it would mean holding this
    telescope because of a sky somewhere else."""
    import uuid

    agent = build_agent(max_altitude_degrees=70.0)
    try:
        agent.own()
        agent.weather(hold_active=True, observatory_id=uuid.uuid4())

        assert agent.supervisor.validator.weather_hold is False
        ack = agent.command(agent.goto())
        assert ack is not None and ack["status"] == "ACCEPTED", ack
    finally:
        agent.close()
