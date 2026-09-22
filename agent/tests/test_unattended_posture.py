"""The agent's unattended posture (ADR-024, DV-126).

An approved partner, and a first-party queued capture, need a telescope that
runs with nobody beside it. Before this, the only way was to start the agent
with the attended flag and walk away -- a false flag that also armed the daylight
override. These tests are the rules that replaced it:

- a process never starts unattended; it is armed from ATTENDED, locally, for
  that run only
- unattended removes the daylight override and nothing else
- any fault, a withdrawn approval, a sustained outage or a local disarm latches
  it off, Parks, and nothing but a new arming undoes it
- the cloud can disarm and never arm

Simulator only, like every other test here.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from contracts.models import AgentPosture, DisarmReason
from darkview_agent import arming
from darkview_agent.safety.posture import PostureLatch
from tests import command_fixtures as commands
from tests.agent_harness import (
    DAYLIGHT_DEC_DEGREES,
    DAYLIGHT_RA_HOURS,
    NOON,
    OBSERVATORY_ID,
    build_agent,
    hello_from,
)


def _arm(agent, operator: str = "Nika") -> None:
    agent.store.append_posture_request(
        agent.supervisor.run_id, "ARM", operator, datetime.now(UTC)
    )
    agent.pump()


def _disarm(agent, operator: str = "Nika") -> None:
    agent.store.append_posture_request(
        agent.supervisor.run_id, "DISARM", operator, datetime.now(UTC)
    )
    agent.pump()


def _approval(agent, status: str) -> None:
    agent.deliver(
        {
            "type": "CLOUD_OPERATING_UPDATE",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "observatoryId": str(OBSERVATORY_ID),
            "approvalStatus": status,
        }
    )
    agent.pump()


def _armed_agent(tmp_path, **kwargs):
    agent = build_agent(
        max_altitude_degrees=70.0,
        attended=True,
        state_path=tmp_path / "agent-state.sqlite3",
        **kwargs,
    )
    _arm(agent)
    assert agent.supervisor.posture.posture is AgentPosture.unattended
    return agent


def _audit_kinds(agent) -> list[str]:
    return [event.kind for event in agent.supervisor.audit.events()]


# ----------------------------------------------------------------------
# Entering it
# ----------------------------------------------------------------------


def test_a_new_process_starts_simulated_or_attended_and_never_unattended():
    plain = build_agent(max_altitude_degrees=70.0)
    present = build_agent(max_altitude_degrees=70.0, attended=True)

    assert plain.supervisor.posture.posture is AgentPosture.simulated
    assert present.supervisor.posture.posture is AgentPosture.attended
    assert hello_from(present)["posture"] == "ATTENDED"
    assert hello_from(present)["disarmReason"] is None


def test_arming_from_attended_goes_unattended_and_the_heartbeat_says_so(tmp_path):
    agent = _armed_agent(tmp_path)
    try:
        assert "POSTURE_ARMED" in _audit_kinds(agent)
        assert agent.supervisor.validator.attended is False

        agent.advance(6.0)
        heartbeat = agent.connector.current.sent_of_type("AGENT_HEARTBEAT")[-1]
        assert heartbeat["posture"] == "UNATTENDED"
    finally:
        agent.close()


def test_an_agent_nobody_declared_present_cannot_be_armed(tmp_path):
    agent = build_agent(max_altitude_degrees=70.0, state_path=tmp_path / "s.sqlite3")
    try:
        _arm(agent)

        assert agent.supervisor.posture.posture is AgentPosture.simulated
        assert "POSTURE_ARM_REFUSED" in _audit_kinds(agent)
    finally:
        agent.close()


def test_real_drivers_cannot_be_armed_until_a_sky_sensor_exists():
    latch = PostureLatch(AgentPosture.attended, real_drivers=True)

    refusal = latch.arm()

    assert refusal is not None and "sky sensor" in refusal
    assert latch.posture is AgentPosture.attended


def test_an_arming_written_for_another_run_is_ignored(tmp_path):
    agent = build_agent(
        max_altitude_degrees=70.0, attended=True, state_path=tmp_path / "s.sqlite3"
    )
    try:
        agent.store.append_posture_request(uuid4(), "ARM", "Nika", datetime.now(UTC))
        agent.pump()

        assert agent.supervisor.posture.posture is AgentPosture.attended
        assert "POSTURE_REQUEST_IGNORED" in _audit_kinds(agent)
    finally:
        agent.close()


def test_a_restarted_agent_never_comes_back_unattended(tmp_path):
    """A power cut ends unattended operation. The arming named the old run."""
    path = tmp_path / "agent-state.sqlite3"
    agent = build_agent(max_altitude_degrees=70.0, attended=True, state_path=path)
    _arm(agent)
    assert agent.supervisor.posture.posture is AgentPosture.unattended
    agent.close()

    revived = build_agent(max_altitude_degrees=70.0, attended=True, state_path=path)
    try:
        revived.pump()
        assert revived.supervisor.posture.posture is AgentPosture.attended
        assert hello_from(revived)["posture"] == "ATTENDED"
    finally:
        revived.close()


# ----------------------------------------------------------------------
# What it removes
# ----------------------------------------------------------------------


def test_unattended_refuses_the_daylight_override_the_cloud_asks_for(tmp_path):
    agent = _armed_agent(tmp_path, start=NOON)
    try:
        agent.own()
        ack = agent.command(
            agent.goto(
                ra_hours=DAYLIGHT_RA_HOURS,
                dec_degrees=DAYLIGHT_DEC_DEGREES,
                issued_by_operator_id=uuid4(),
                override_reason="terrestrial focus check",
            )
        )

        assert ack["status"] == "REJECTED"
        assert ack["rejectionReason"] == "SAFETY_DAYLIGHT_LOCK"
    finally:
        agent.close()


def test_unattended_still_accepts_a_live_customers_goto_and_nudge(tmp_path):
    """ADR-024 §1: the posture removes the override, not the customer."""
    agent = _armed_agent(tmp_path)
    try:
        agent.own()
        assert agent.command(agent.goto())["status"] == "ACCEPTED"
    finally:
        agent.close()


# ----------------------------------------------------------------------
# The latch
# ----------------------------------------------------------------------


def test_a_device_fault_disarms_and_a_reconnect_does_not_rearm(tmp_path):
    agent = _armed_agent(tmp_path)
    try:
        agent.supervisor.watchdog.report_device_fault("camera stopped answering")
        agent.supervisor.watchdog.evaluate()
        agent.pump()

        assert agent.supervisor.posture.posture is AgentPosture.disarmed
        assert agent.supervisor.posture.disarm_reason is DisarmReason.hardware_fault
        assert agent.mount.status().parked is True

        dead = agent.connector.current
        dead.kill()
        agent.advance(10.0, steps=10)  # past the backoff, so it redials
        assert agent.connector.current is not dead
        agent.connector.current.deliver_welcome(server_time=agent.wall.now)
        agent.pump()
        _approval(agent, "APPROVED")

        assert agent.supervisor.posture.posture is AgentPosture.disarmed
        hello = hello_from(agent)
        assert hello["posture"] == "DISARMED"
        assert hello["disarmReason"] == "HARDWARE_FAULT"
    finally:
        agent.close()


def test_disarmed_refuses_everything_but_park_and_abort(tmp_path):
    agent = _armed_agent(tmp_path)
    try:
        agent.own()
        _disarm(agent)

        refused = agent.command(agent.goto())
        assert refused["status"] == "REJECTED"
        assert refused["rejectionReason"] == "UNATTENDED_DISARMED"

        park = agent.command(commands.envelope(command_type="PARK", issued_at=agent.wall.now))
        assert park["status"] == "ACCEPTED", park
    finally:
        agent.close()


def test_a_disarmed_agent_cannot_be_armed_again_without_a_restart(tmp_path):
    agent = _armed_agent(tmp_path)
    try:
        _disarm(agent)
        _arm(agent)

        assert agent.supervisor.posture.posture is AgentPosture.disarmed
        assert "POSTURE_ARM_REFUSED" in _audit_kinds(agent)
    finally:
        agent.close()


def test_a_local_disarm_parks_the_mount(tmp_path):
    agent = _armed_agent(tmp_path)
    try:
        agent.own()
        agent.command(agent.goto())
        agent.advance(5.0, steps=5)
        assert agent.mount.status().parked is False

        _disarm(agent)
        agent.supervisor.watchdog.evaluate()
        agent.pump()

        assert agent.supervisor.posture.disarm_reason is DisarmReason.local_disarm
        assert agent.mount.status().parked is True
    finally:
        agent.close()


def test_the_cloud_can_disarm_and_never_arm(tmp_path):
    attended = build_agent(
        max_altitude_degrees=70.0, attended=True, state_path=tmp_path / "a.sqlite3"
    )
    try:
        _approval(attended, "APPROVED")
        assert attended.supervisor.posture.posture is AgentPosture.attended
    finally:
        attended.close()

    agent = _armed_agent(tmp_path)
    try:
        _approval(agent, "APPROVED")
        assert agent.supervisor.posture.posture is AgentPosture.unattended

        _approval(agent, "SUSPENDED")
        assert agent.supervisor.posture.posture is AgentPosture.disarmed
        assert agent.supervisor.posture.disarm_reason is DisarmReason.approval_withdrawn
    finally:
        agent.close()


def test_an_unreadable_approval_status_disarms(tmp_path):
    agent = _armed_agent(tmp_path)
    try:
        _approval(agent, "SOMETHING_ELSE")
        assert agent.supervisor.posture.posture is AgentPosture.disarmed
    finally:
        agent.close()


def test_a_brief_outage_parks_but_does_not_disarm(tmp_path):
    """ADR-024 answer 4: the watchdog Parks, and only a sustained loss disarms."""
    agent = _armed_agent(tmp_path, sustained_link_loss_seconds=600.0)
    try:
        agent.connector.current.kill()
        agent.advance(61.0, steps=4)
        action = agent.supervisor.watchdog.evaluate()
        assert action is not None and action.parked is True
        agent.pump()

        assert agent.supervisor.posture.posture is AgentPosture.unattended

        agent.connector.current.deliver_welcome(server_time=agent.wall.now)
        agent.pump()
        assert agent.supervisor.posture.posture is AgentPosture.unattended
    finally:
        agent.close()


def test_a_sustained_outage_disarms(tmp_path):
    agent = _armed_agent(tmp_path, sustained_link_loss_seconds=600.0)
    try:
        agent.connector.current.kill()
        agent.advance(601.0, steps=10)

        assert agent.supervisor.posture.posture is AgentPosture.disarmed
        assert agent.supervisor.posture.disarm_reason is DisarmReason.link_lost
    finally:
        agent.close()


def test_with_no_measured_limit_the_dead_link_park_disarms(tmp_path):
    """Until DV-037 measures the sustained-loss limit, the conservative end."""
    agent = _armed_agent(tmp_path)
    try:
        agent.connector.current.kill()
        agent.advance(61.0, steps=4)
        agent.supervisor.watchdog.evaluate()
        agent.pump()

        assert agent.supervisor.posture.disarm_reason is DisarmReason.link_lost
    finally:
        agent.close()


# ----------------------------------------------------------------------
# The command line
# ----------------------------------------------------------------------


def test_the_command_line_arms_the_running_agent(tmp_path):
    path = tmp_path / "agent-state.sqlite3"
    agent = build_agent(max_altitude_degrees=70.0, attended=True, state_path=path)
    try:
        said: list[str] = []
        code = arming.run_request(
            arming.ARM, "Nika", {"DARKVIEW_AGENT_STATE_PATH": str(path)}, said.append
        )
        agent.pump()

        assert code == 0, said
        assert agent.supervisor.posture.posture is AgentPosture.unattended
    finally:
        agent.close()


def test_the_command_line_refuses_to_arm_an_agent_that_is_not_attended(tmp_path):
    path = tmp_path / "agent-state.sqlite3"
    agent = build_agent(max_altitude_degrees=70.0, state_path=path)
    try:
        said: list[str] = []
        code = arming.run_request(
            arming.ARM, "Nika", {"DARKVIEW_AGENT_STATE_PATH": str(path)}, said.append
        )

        assert code == 1
        assert "ATTENDED" in said[0]
    finally:
        agent.close()


def test_the_command_line_does_not_forget_a_command_the_agent_is_carrying_out(tmp_path):
    """Opening the store runs start-up maintenance. Beside a live agent it must not."""
    path = tmp_path / "agent-state.sqlite3"
    agent = build_agent(max_altitude_degrees=70.0, attended=True, state_path=path)
    try:
        agent.store.remember("in-flight-command", datetime.now(UTC))

        arming.run_request(
            arming.DISARM, "Nika", {"DARKVIEW_AGENT_STATE_PATH": str(path)}, lambda _: None
        )

        assert agent.store.has("in-flight-command") is True
    finally:
        agent.close()
