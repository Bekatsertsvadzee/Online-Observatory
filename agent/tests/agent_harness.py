"""One assembled agent, with a fake socket and clocks a test can move.

Same role as `command_fixtures` and `envelope_fixtures`: the supervisor tests and
the restart tests both drive a whole agent, and a second copy of this would be a
second place for the wiring under test to drift.

Deliberately built through `build_supervisor` rather than by hand. That is the
function the process uses, so a test that assembled its own supervisor could pass
while the real wiring was wrong -- which is exactly the failure DV-040 existed to
fix.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

from contracts.models import MissionState
from darkview_agent.clock import ManualClock
from darkview_agent.config import AgentConfig
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.mission.solver import SimSolver
from darkview_agent.runtime import Devices
from darkview_agent.safety.envelope import SafetyEnvelope
from darkview_agent.state.store import StateStore
from darkview_agent.supervisor import Supervisor, build_supervisor
from tests import command_fixtures as commands
from tests.envelope_fixtures import TBILISI, build_config
from tests.fake_transport import Connector

OBSERVATORY_ID = uuid4()

# Deep night over Tbilisi, so daylight lock and Sun exclusion are satisfied and a
# test can isolate the rule it is about.
NIGHT = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)
# Local solar noon over Tbilisi. Sun at altitude 71.7.
NOON = datetime(2026, 6, 21, 9, 0, tzinfo=UTC)

# 17h00 +20 sits at altitude 56.662, azimuth 238.572 over Tbilisi at NIGHT.
# Comfortably inside a 20..70 envelope and far from the Sun, so it is refused
# only by a rule a test deliberately set.
TARGET_RA_HOURS = 17.0
TARGET_DEC_DEGREES = 20.0
TARGET_ALTITUDE = 56.662

# 15h00 +75 sits at altitude 30.313 at NOON, 77.5 degrees from the Sun: above the
# minimum altitude and outside the Sun exclusion, so the daylight lock is the only
# rule that can refuse it.
DAYLIGHT_RA_HOURS = 15.0
DAYLIGHT_DEC_DEGREES = 75.0


class Wall:
    """The wall clock, moved by hand. Separate from the monotonic ManualClock:
    one decides where the sky is, the other decides how far a slew has run."""

    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> datetime:
        self.now += timedelta(seconds=seconds)
        return self.now


@dataclass
class Agent:
    """One assembled agent with a fake socket, and the levers a test needs."""

    supervisor: Supervisor
    connector: Connector
    clock: ManualClock
    wall: Wall
    devices: Devices
    store: StateStore | None = None

    @property
    def mount(self) -> SimMount:
        return self.devices.mount  # type: ignore[return-value]

    # -- driving --------------------------------------------------------

    def close(self) -> None:
        if self.store is not None:
            self.store.close()

    def deliver(self, message: dict) -> None:
        self.connector.current.deliver(message)

    def pump(self, times: int = 1) -> None:
        for _ in range(times):
            self.supervisor.pump()

    def advance(self, seconds: float, steps: int = 1) -> None:
        """Move both clocks together and pump, so simulated motion completes."""
        for _ in range(steps):
            self.clock.advance(seconds / steps)
            self.wall.advance(seconds / steps)
            self.pump()

    def own(
        self,
        *,
        mission_id: UUID | None = commands.MISSION_ID,
        session_id: UUID | None = commands.SESSION_ID,
        user_id: UUID | None = commands.USER_ID,
        expires_at: datetime | None = None,
    ) -> None:
        self.deliver(
            {
                "type": "CLOUD_SESSION_UPDATE",
                "messageId": str(uuid4()),
                "sentAt": self.wall.now.isoformat(),
                "missionId": str(mission_id) if mission_id else None,
                "sessionId": str(session_id) if session_id else None,
                "userId": str(user_id) if user_id else None,
                "expiresAt": expires_at.isoformat() if expires_at else None,
            }
        )
        self.pump()

    def command(self, envelope: dict) -> dict | None:
        """Send one command and return the ack that came back, if any."""
        before = len(self.acks())
        self.deliver(
            {
                "type": "CLOUD_COMMAND",
                "messageId": str(uuid4()),
                "sentAt": self.wall.now.isoformat(),
                "command": envelope,
            }
        )
        self.pump()
        acks = self.acks()
        return acks[-1] if len(acks) > before else None

    # -- envelopes ------------------------------------------------------

    def goto(self, *, recenter: bool = False, **kwargs) -> dict:
        payload = commands.goto_payload(
            ra_hours=kwargs.pop("ra_hours", TARGET_RA_HOURS),
            dec_degrees=kwargs.pop("dec_degrees", TARGET_DEC_DEGREES),
        )
        payload["recenter"] = recenter
        return commands.goto(payload=payload, issued_at=self.wall.now, **kwargs)

    def nudge(self, *, step_arcminutes: float = 6.0, **kwargs) -> dict:
        payload = commands.nudge_payload(
            step_arcminutes=step_arcminutes,
            axis=kwargs.pop("axis", "ALTITUDE"),
            direction=kwargs.pop("direction", "POSITIVE"),
        )
        return commands.nudge(payload=payload, issued_at=self.wall.now, **kwargs)

    # -- reading the wire -----------------------------------------------

    def sent(self, message_type: str) -> list[dict]:
        return [
            message
            for message in (json.loads(payload) for payload in self.connector.current.sent)
            if message.get("type") == message_type
        ]

    def acks(self) -> list[dict]:
        return self.sent("AGENT_COMMAND_ACK")

    def events(self) -> list[dict]:
        return self.sent("AGENT_MISSION_EVENT")


def build_agent(
    *,
    max_altitude_degrees: float | None,
    nudge_max_degrees: float = 2.0,
    nudge_rate_degrees_per_second: float = 0.5,
    attended: bool = False,
    site=TBILISI,
    start: datetime = NIGHT,
    solve_error_degrees: float = 0.0,
    online: bool = True,
    state_path: Path | None = None,
    mount: SimMount | None = None,
) -> Agent:
    """Assemble one agent. Passing the same `state_path` twice is a restart.

    `mount` exists for the restart tests. A crashed agent does not park anything
    on its way out -- the mount keeps tracking wherever it was -- so a test about
    recovery has to be able to hand the new agent a telescope that is still
    pointing somewhere, rather than the parked one a fresh `SimMount` would be.
    """
    clock = ManualClock()
    wall = Wall(start)

    mount = SimMount(clock) if mount is None else mount
    devices = Devices(mount=mount, camera=SimCamera(clock, mount), focuser=SimFocuser(clock))

    config = AgentConfig(
        attended=attended,
        cloud_url="wss://cloud.invalid/ws/agent",
        device_token="a-device-token",
        observatory_id=OBSERVATORY_ID,
        site=site,
        state_path=state_path or Path("unused-in-memory"),
    )
    envelope = SafetyEnvelope(
        config=build_config(
            max_altitude_degrees=max_altitude_degrees,
            nudge_max_degrees=nudge_max_degrees,
            nudge_rate_degrees_per_second=nudge_rate_degrees_per_second,
        ),
        site=site,
    )

    connector = Connector()
    store = StateStore(state_path) if state_path is not None else None
    supervisor = build_supervisor(
        config=config,
        devices=devices,
        connect=connector,
        envelope=envelope,
        solver=SimSolver(initial_error_degrees=solve_error_degrees),
        store=store,
        clock=clock,
        now=wall,
    )
    # Before the first pump, because the hello that pump sends is where a
    # recovered mission is reported.
    supervisor.recover()

    agent = Agent(
        supervisor=supervisor,
        connector=connector,
        clock=clock,
        wall=wall,
        devices=devices,
        store=store,
    )
    if online:
        agent.pump()  # dial out and say hello
        connector.current.deliver_welcome()
        agent.pump()  # welcome received; the link is ONLINE
    return agent


def hello_from(agent: Agent) -> dict:
    """The most recent AGENT_HELLO on the current connection."""
    hellos = [
        message
        for message in (json.loads(payload) for payload in agent.connector.current.sent)
        if message.get("type") == "AGENT_HELLO"
    ]
    assert hellos, "the agent has not said hello on this connection"
    return hellos[-1]


def run_to(agent: Agent, state: MissionState, budget_seconds: float = 240.0) -> None:
    """Advance until the mission reaches a state, or fail saying where it stopped."""
    for _ in range(int(budget_seconds / 2)):
        if agent.supervisor.runner.state is state:
            return
        agent.advance(2.0)
    raise AssertionError(
        f"mission never reached {state.value}; it is in "
        f"{agent.supervisor.runner.state.value}"
    )
