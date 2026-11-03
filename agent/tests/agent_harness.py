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
from darkview_agent.config import AgentConfig, DriverMode
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

    @property
    def camera(self) -> SimCamera:
        return self.devices.camera  # type: ignore[return-value]

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

    def weather(
        self,
        *,
        hold_active: bool,
        status: str = "CLOUDY",
        note: str | None = None,
        observatory_id: UUID | None = None,
    ) -> None:
        """Deliver one CLOUD_WEATHER_UPDATE and pump."""
        self.deliver(
            {
                "type": "CLOUD_WEATHER_UPDATE",
                "messageId": str(uuid4()),
                "sentAt": self.wall.now.isoformat(),
                "observatoryId": str(observatory_id or OBSERVATORY_ID),
                "weather": {
                    "status": status,
                    "source": "OPERATOR",
                    "holdActive": hold_active,
                    "note": note,
                    "updatedAt": self.wall.now.isoformat(),
                },
            }
        )
        self.pump()

    def command(self, envelope: dict, sent_at: datetime | None = None) -> dict | None:
        """Send one command and return the ack that came back, if any.

        `sentAt` is the cloud's stamp, and it defaults to the moment the cloud
        issued the command inside it -- not to the agent's wall clock, which a
        fake cloud reading it could never use to model the two disagreeing. Pass
        `sent_at` for the other case: a command the cloud issued a while ago and
        is only sending now.
        """
        before = len(self.acks())
        self.deliver(
            {
                "type": "CLOUD_COMMAND",
                "messageId": str(uuid4()),
                "sentAt": (
                    sent_at.isoformat()
                    if sent_at is not None
                    else envelope.get("issuedAt", self.wall.now.isoformat())
                ),
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

    def retarget(self, **kwargs) -> dict:
        payload = commands.retarget_payload(
            ra_hours=kwargs.pop("ra_hours", TARGET_RA_HOURS),
            dec_degrees=kwargs.pop("dec_degrees", TARGET_DEC_DEGREES),
            target_id=kwargs.pop("target_id", None),
            imaging_profile=kwargs.pop("imaging_profile", "GLOBULAR_CLUSTER"),
        )
        return commands.retarget(payload=payload, issued_at=self.wall.now, **kwargs)

    def capture(self, *, frames: int = 3, **kwargs) -> dict:
        payload = dict(commands.capture_payload(), requestedFrames=frames)
        return commands.capture(payload=payload, issued_at=self.wall.now, **kwargs)

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
    uploader=None,
    max_observing_seconds: float = 30.0,
    sustained_link_loss_seconds: float | None = None,
    driver_mode: DriverMode = DriverMode.SIMULATED,
    frame_size: tuple[int, int] | None = None,
    solver: SimSolver | None = None,
) -> Agent:
    """Assemble one agent. Passing the same `state_path` twice is a restart.

    `max_observing_seconds` is short by default: long enough for a ten-frame
    capture, short enough to pump through. A mission observes until its session's
    `expiresAt` (ADR-079), and a test that never sends one would otherwise observe
    for the four-hour ceiling. A test about the slot's end passes `expires_at` to
    `own` and a long ceiling.

    `mount` exists for the restart tests. A crashed agent does not park anything
    on its way out -- the mount keeps tracking wherever it was -- so a test about
    recovery has to be able to hand the new agent a telescope that is still
    pointing somewhere, rather than the parked one a fresh `SimMount` would be.
    """
    clock = ManualClock()
    wall = Wall(start)

    mount = SimMount(clock) if mount is None else mount
    camera = (
        SimCamera(clock, mount)
        if frame_size is None
        else SimCamera(clock, mount, width_px=frame_size[0], height_px=frame_size[1])
    )
    devices = Devices(mount=mount, camera=camera, focuser=SimFocuser(clock))

    config = AgentConfig(
        driver_mode=driver_mode,
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
        solver=solver or SimSolver(initial_error_degrees=solve_error_degrees),
        store=store,
        clock=clock,
        now=wall,
        uploader=uploader,
        max_observing_seconds=max_observing_seconds,
        sustained_link_loss_seconds=sustained_link_loss_seconds,
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
        connector.current.deliver_welcome(server_time=wall.now)
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
    """Advance until the mission reaches a state, or fail saying where it stopped.

    CAPTURING and PROCESSING are only reached by a CAPTURE (ADR-079 §5), so for
    either of them this presses Capture once the mission is observing -- ten
    frames, the run every test before ADR-079 got without asking.
    """
    runner = agent.supervisor.runner
    wants_capture = state in (MissionState.capturing, MissionState.processing)
    for _ in range(int(budget_seconds / 2)):
        if runner.state is state:
            return
        if wants_capture and runner.state is MissionState.observing and not runner.capture_pending:
            ack = agent.command(agent.capture(frames=10))
            assert ack is not None and ack["status"] == "ACCEPTED", ack
            continue
        agent.advance(2.0)
    raise AssertionError(
        f"mission never reached {state.value}; it is in "
        f"{agent.supervisor.runner.state.value}"
    )
