"""`check-devices`: the read-only bring-up check, against the fakes.

What matters most here is what it does not do: send anything that moves the mount
or the focuser, run in the simulator's place, or open a socket to the cloud.
"""

from __future__ import annotations

import os
import socket
from pathlib import Path

import pytest

from darkview_agent import check_devices
from darkview_agent.__main__ import main as entrypoint_main
from darkview_agent.clock import ManualClock
from darkview_agent.config import AgentConfig, DriverMode
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.zwo import ZwoCamera
from darkview_agent.mission.solver import SolveResult
from tests.fake_alpaca import NOT_IMPLEMENTED, FakeAlpacaBridge
from tests.fake_asi import FakeAsiCamera


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock()


@pytest.fixture
def bridge(clock) -> FakeAlpacaBridge:
    return FakeAlpacaBridge(clock)


@pytest.fixture
def asi(clock) -> FakeAsiCamera:
    return FakeAsiCamera(clock)


@pytest.fixture
def config(tmp_path) -> AgentConfig:
    return AgentConfig(
        driver_mode=DriverMode.REAL, attended=True, state_path=tmp_path / "agent-state.sqlite3"
    )


def run(config, bridge, asi, clock, **options) -> tuple[int, list[str]]:
    said: list[str] = []
    code = check_devices.run_check_devices(
        config,
        said.append,
        transport=bridge.transport,
        camera_factory=lambda: ZwoCamera(asi),
        monotonic=clock.monotonic,
        sleep=clock.advance,
        **options,
    )
    return code, said


def lines(said: list[str], prefix: str) -> list[str]:
    return [line for line in said if line.startswith(prefix)]


def test_a_healthy_observatory_passes_every_step(config, bridge, asi, clock):
    code, said = run(config, bridge, asi, clock)

    assert code == 0, said
    assert lines(said, "FAIL") == []
    for step in ("alpaca bridge", "mount CanSlewAltAzAsync", "mount CanPark", "mount CanUnpark",
                 "mount CanSetTracking", "mount state", "focuser absolute", "focuser state",
                 "camera", "exposure"):
        assert any(line.startswith(f"PASS {step}") for line in said), step


def test_nothing_that_moves_is_ever_sent(config, bridge, asi, clock):
    bridge.focuser.tempcomp = True
    run(config, bridge, asi, clock)

    assert bridge.moving_requests() == []
    assert bridge.telescope.mount.status().slewing is False


def test_the_mount_and_focuser_report_what_they_hold(config, bridge, asi, clock):
    code, said = run(config, bridge, asi, clock)

    state = lines(said, "PASS mount state")[0]
    assert "AtPark True" in state and "Tracking False" in state and "altitude" in state
    focuser = lines(said, "PASS focuser state")[0]
    assert "position 15000 of MaxStep 30000" in focuser
    assert "temperature 11.5" in focuser


def test_devices_it_connected_are_released_and_ones_already_connected_are_left(
    config, bridge, asi, clock
):
    bridge.telescope.connected = True
    bridge.telescope.mount.connect()

    run(config, bridge, asi, clock)

    assert bridge.telescope.connected is True
    assert bridge.telescope.puts("connected") == []
    assert bridge.focuser.connected is False
    assert bridge.focuser.puts("connected") == [{"Connected": "True"}, {"Connected": "False"}]


def test_each_missing_mount_capability_is_its_own_failure(config, bridge, asi, clock):
    bridge.telescope.capabilities["canslewaltazasync"] = False
    bridge.telescope.capabilities["cansettracking"] = False

    code, said = run(config, bridge, asi, clock)

    assert code == 1
    assert [line.split(":")[0] for line in lines(said, "FAIL")] == [
        "FAIL mount CanSlewAltAzAsync",
        "FAIL mount CanSetTracking",
    ]


def test_a_relative_only_focuser_fails(config, bridge, asi, clock):
    bridge.focuser.absolute = False
    code, said = run(config, bridge, asi, clock)
    assert code == 1
    assert lines(said, "FAIL focuser absolute")


def test_a_focuser_without_temperature_still_passes(config, bridge, asi, clock):
    bridge.focuser.temperature = None
    bridge.focuser.tempcomp = None
    code, said = run(config, bridge, asi, clock)
    assert code == 0, said
    assert "temperature not reported" in lines(said, "PASS focuser state")[0]


def test_an_unreachable_bridge_fails_every_alpaca_step_and_still_checks_the_camera(
    config, bridge, asi, clock
):
    bridge.unreachable = True
    code, said = run(config, bridge, asi, clock)

    assert code == 1
    assert [line.split(":")[0] for line in lines(said, "FAIL")] == [
        "FAIL alpaca bridge",
        "FAIL mount (telescope 0)",
        "FAIL focuser (focuser 0)",
    ]
    assert lines(said, "PASS exposure")


def test_the_frame_is_saved_as_fits_under_the_state_folder(config, bridge, asi, clock):
    code, said = run(config, bridge, asi, clock, exposure_seconds=2.0, gain=100)

    saved = list((config.state_path.parent / "device-check").glob("check-*.fits"))
    assert len(saved) == 1
    assert saved[0].read_bytes()[:30].startswith(b"SIMPLE  =")
    assert str(saved[0]) in lines(said, "PASS exposure")[0]
    assert asi.started == [(2_000_000, 100)]
    assert asi.closed is True


def test_the_camera_s_description_is_reported(config, bridge, asi, clock):
    _, said = run(config, bridge, asi, clock)
    camera = lines(said, "PASS camera")[0]
    assert "ZWO ASI585MC" in camera and "64x48" in camera and "Bayer RGGB" in camera


def test_a_failed_exposure_fails_the_check(config, bridge, asi, clock):
    asi.fail_next = True
    code, said = run(config, bridge, asi, clock)
    assert code == 1
    assert lines(said, "FAIL exposure")
    assert asi.closed is True


def test_a_camera_that_will_not_open_fails_the_check(config, bridge, asi, clock):
    def unopenable():
        raise DeviceError("expected exactly one camera named ASI585MC, found 0")

    asi.open = unopenable
    code, said = run(config, bridge, asi, clock)
    assert code == 1
    assert "found 0" in lines(said, "FAIL camera")[0]


def test_without_an_sdk_path_the_camera_step_says_what_to_set(config, bridge):
    said: list[str] = []
    code = check_devices.run_check_devices(config, said.append, transport=bridge.transport)
    assert code == 1
    assert "DARKVIEW_AGENT_ZWO_SDK_PATH" in lines(said, "FAIL camera")[0]


def test_solving_is_only_attempted_when_asked(config, bridge, asi, clock):
    asked = []

    def solver():
        asked.append(True)
        raise AssertionError("not asked for")

    run(config, bridge, asi, clock, solver_factory=solver)
    assert asked == []


class _Solver:
    def __init__(self, result):
        self.result = result

    def solve(self, frame):
        return self.result


def test_a_solved_frame_is_reported(config, bridge, asi, clock):
    code, said = run(
        config, bridge, asi, clock, solve=True,
        solver_factory=lambda: _Solver(SolveResult(5.5881, -5.3911)),
    )
    assert code == 0, said
    assert "RA 5.5881 h" in lines(said, "PASS plate solve")[0]


def test_an_unsolved_frame_fails_when_a_solve_was_asked_for(config, bridge, asi, clock):
    code, said = run(config, bridge, asi, clock, solve=True, solver_factory=lambda: _Solver(None))
    assert code == 1
    assert lines(said, "FAIL plate solve")


def test_a_solve_without_astap_configured_says_what_to_set(config, bridge, asi, clock):
    code, said = run(config, bridge, asi, clock, solve=True)
    assert code == 1
    assert "DARKVIEW_AGENT_ASTAP_PATH" in lines(said, "FAIL plate solve")[0]


@pytest.mark.parametrize(
    "posture",
    [
        AgentConfig(),
        AgentConfig(driver_mode=DriverMode.SIMULATED, attended=True),
        AgentConfig(driver_mode=DriverMode.REAL, attended=False),
    ],
)
def test_it_refuses_to_run_unless_real_and_attended(posture, bridge, asi, clock):
    code, said = run(posture, bridge, asi, clock)
    assert code == 2
    assert said[0].startswith("FAIL configuration")
    assert bridge.telescope.requests == [] and bridge.focuser.requests == []
    assert asi.open_count == 0


def test_it_dials_nothing_but_the_injected_bridge(config, bridge, asi, clock, monkeypatch):
    def no_dialling(*_args, **_kwargs):
        raise AssertionError("the device check opened a network connection")

    monkeypatch.setattr(socket, "create_connection", no_dialling)
    monkeypatch.setattr(socket.socket, "connect", no_dialling)

    code, _ = run(config, bridge, asi, clock)
    assert code == 0


def test_a_mount_that_does_not_implement_a_read_fails_that_step(config, bridge, asi, clock):
    bridge.telescope.fail_members["altitude"] = (NOT_IMPLEMENTED, "no altitude")
    code, said = run(config, bridge, asi, clock)
    assert code == 1
    assert "no altitude" in lines(said, "FAIL mount (telescope 0)")[0]


# The command line


@pytest.fixture
def clean_environment(monkeypatch, tmp_path):
    for name in list(os.environ):
        if name.startswith("DARKVIEW_AGENT_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("DARKVIEW_AGENT_ENV_FILE", str(tmp_path / "absent.env"))


def test_the_command_refuses_the_simulator(clean_environment, capsys):
    assert entrypoint_main([check_devices.COMMAND]) == 2
    assert "DARKVIEW_AGENT_DRIVER_MODE=REAL" in capsys.readouterr().out


def test_the_command_refuses_real_without_attended(clean_environment, monkeypatch, capsys):
    monkeypatch.setenv("DARKVIEW_AGENT_DRIVER_MODE", "REAL")
    assert entrypoint_main([check_devices.COMMAND]) == 2
    assert "DARKVIEW_AGENT_ATTENDED" in capsys.readouterr().out


def test_a_setup_file_cannot_select_real_for_the_check(clean_environment, monkeypatch, tmp_path):
    path = Path(tmp_path / "agent.env")
    path.write_text("DARKVIEW_AGENT_DRIVER_MODE=REAL\nDARKVIEW_AGENT_ATTENDED=1\n")
    monkeypatch.setenv("DARKVIEW_AGENT_ENV_FILE", str(path))
    assert entrypoint_main([check_devices.COMMAND]) == 2


def test_the_command_passes_its_options_through(clean_environment, monkeypatch):
    monkeypatch.setenv("DARKVIEW_AGENT_DRIVER_MODE", "REAL")
    monkeypatch.setenv("DARKVIEW_AGENT_ATTENDED", "1")
    seen = {}
    monkeypatch.setattr(
        check_devices,
        "run_check_devices",
        lambda config, say, **options: seen.update(options, attended=config.attended) or 0,
    )

    code = entrypoint_main(
        [check_devices.COMMAND, "--exposure-seconds", "0.5", "--gain", "200", "--solve"]
    )

    assert code == 0
    assert seen == {"exposure_seconds": 0.5, "gain": 200, "solve": True, "attended": True}


@pytest.mark.parametrize("seconds", ["0", "-1", "61"])
def test_an_exposure_outside_the_check_s_range_is_refused(clean_environment, seconds):
    with pytest.raises(SystemExit):
        entrypoint_main([check_devices.COMMAND, "--exposure-seconds", seconds])
