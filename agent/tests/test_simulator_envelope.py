"""ADR-032: the simulator's altitude limit never stands on real hardware.

The development seed gives SIMULATED demo observatories a MAX_ALT_SAFE recorded
under `SIMULATOR_ENVELOPE_MEASURER`, because it was never measured. The cloud
withholds it from anything not SIMULATED; these tests hold the agent to doing the
same on its own, whatever the cloud sends.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from uuid import uuid4

import pytest

from contracts.models import CommandRejectionReason, ObservatoryMode
from darkview_agent.config import DriverMode
from darkview_agent.devices.simulated import SimMount
from darkview_agent.safety.envelope import (
    SIMULATOR_ENVELOPE_MEASURER,
    SafetyEnvelope,
    admit_envelope,
    is_simulator_marked,
)
from tests.agent_harness import build_agent, hello_from
from tests.envelope_fixtures import NIGHT, TBILISI, build_config

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _marked(measured_by: str = SIMULATOR_ENVELOPE_MEASURER):
    return build_config(max_altitude_degrees=78.0).model_copy(
        update={"max_altitude_measured_by": measured_by}
    )


def _deliver(agent, config) -> None:
    agent.deliver(
        {
            "type": "CLOUD_SAFETY_ENVELOPE_UPDATE",
            "messageId": str(uuid4()),
            "sentAt": agent.wall.now.isoformat(),
            "envelope": json.loads(config.model_dump_json(by_alias=True)),
        }
    )
    agent.pump()


class _RealReportingMount(SimMount):
    """A simulator that reports itself as real hardware, as a real driver would."""

    @property
    def mode(self) -> ObservatoryMode:
        return ObservatoryMode.real


def test_the_marker_is_the_same_string_the_cloud_uses():
    source = (REPOSITORY_ROOT / "packages/db/simulator-envelope.ts").read_text("utf-8")
    match = re.search(r'SIMULATOR_ENVELOPE_MEASURER = "([^"]+)"', source)
    assert match is not None
    assert match.group(1) == SIMULATOR_ENVELOPE_MEASURER


@pytest.mark.parametrize(
    "measured_by",
    [SIMULATOR_ENVELOPE_MEASURER, "simulator - not a measurement", "  Simulator"],
)
def test_any_spelling_of_the_marker_counts(measured_by):
    assert is_simulator_marked(_marked(measured_by)) is True


def test_a_person_is_not_the_simulator():
    assert is_simulator_marked(_marked("Beka Tsertsvadze")) is False
    assert admit_envelope(_marked("Beka Tsertsvadze"), simulated=False).max_altitude_degrees == 78.0


def test_the_simulator_may_keep_its_own_limit():
    assert admit_envelope(_marked(), simulated=True).max_altitude_degrees == 78.0


def test_anything_else_reads_it_as_unmeasured():
    assert admit_envelope(_marked(), simulated=False).max_altitude_degrees is None


def test_an_envelope_built_without_saying_simulated_refuses_every_slew():
    """The default is the safe side: nobody has to remember to ask for it."""
    envelope = SafetyEnvelope(config=_marked(), site=TBILISI)

    assert envelope.is_measured is False
    verdict = envelope.evaluate_pointing(NIGHT, 45.0, 180.0)
    assert verdict.reason is CommandRejectionReason.safety_envelope_unmeasured


def test_a_simulated_agent_slews_under_the_simulator_envelope():
    agent = build_agent(max_altitude_degrees=None)
    _deliver(agent, _marked())
    agent.own()

    ack = agent.command(agent.goto())

    assert ack["status"] == "ACCEPTED"


def test_a_real_hardware_agent_refuses_every_slew_under_it():
    agent = build_agent(max_altitude_degrees=None, driver_mode=DriverMode.REAL, attended=True)
    _deliver(agent, _marked())
    agent.own()

    ack = agent.command(agent.goto())

    assert ack["rejectionReason"] == "SAFETY_ENVELOPE_UNMEASURED"
    assert agent.mount.status().parked is True

    # And it tells the cloud it has no usable envelope.
    agent.connector.current.kill()
    agent.advance(2.0, steps=4)
    assert hello_from(agent)["safetyEnvelopeConfigured"] is False


def test_a_real_mount_refuses_it_even_under_a_simulated_configuration():
    agent = build_agent(max_altitude_degrees=None, mount=_RealReportingMount())
    _deliver(agent, _marked())
    agent.own()

    ack = agent.command(agent.goto())

    assert ack["rejectionReason"] == "SAFETY_ENVELOPE_UNMEASURED"


def test_a_stored_simulator_envelope_is_unmeasured_after_a_restart_on_real_hardware(
    tmp_path,
):
    state_path = tmp_path / "agent-state.sqlite3"
    first = build_agent(max_altitude_degrees=None, state_path=state_path)
    _deliver(first, _marked())

    real = build_agent(
        max_altitude_degrees=None,
        state_path=state_path,
        driver_mode=DriverMode.REAL,
        attended=True,
    )
    assert hello_from(real)["safetyEnvelopeConfigured"] is False

    # The stored envelope itself is intact: the simulator reads it back as before.
    simulated = build_agent(max_altitude_degrees=None, state_path=state_path)
    assert hello_from(simulated)["safetyEnvelopeConfigured"] is True
