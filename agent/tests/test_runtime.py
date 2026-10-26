import importlib.util
import logging
import math
import sys

import pytest

from contracts.models import ObservatoryMode, OpticalConfig
from darkview_agent import runtime
from darkview_agent.config import AgentConfig, ConfigurationError, DriverMode, load_config
from darkview_agent.devices.alpaca import AlpacaMount
from darkview_agent.devices.alpaca_focuser import AlpacaFocuser
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.devices.zwo import ZwoCamera
from darkview_agent.mission.solver import SimSolver
from darkview_agent.runtime import build_devices, build_solver, field_height_degrees, start
from darkview_agent.solve.astap import AstapSolver


def test_default_startup_selects_simulated_devices():
    devices = build_devices(load_config({}))
    assert isinstance(devices.mount.driver, SimMount)
    assert isinstance(devices.camera.driver, SimCamera)
    assert isinstance(devices.focuser.driver, SimFocuser)


@pytest.fixture
def hardware(tmp_path, monkeypatch):
    """A REAL, attended configuration with an SDK file and an ASTAP file on disk,
    and the zwoasi binding reported as installed. Nothing is opened or run."""
    sdk = tmp_path / "ASICamera2.dll"
    astap = tmp_path / "astap.exe"
    sdk.write_bytes(b"")
    astap.write_bytes(b"")
    real_find_spec = importlib.util.find_spec
    monkeypatch.setattr(
        runtime.importlib.util,
        "find_spec",
        lambda name, *a: object() if name == "zwoasi" else real_find_spec(name, *a),
    )
    return {
        "DARKVIEW_AGENT_DRIVER_MODE": "REAL",
        "DARKVIEW_AGENT_ATTENDED": "1",
        "DARKVIEW_AGENT_ZWO_SDK_PATH": str(sdk),
        "DARKVIEW_AGENT_ASTAP_PATH": str(astap),
    }


def test_real_mode_builds_the_real_drivers_without_touching_them(hardware):
    devices = build_devices(load_config(hardware))

    assert isinstance(devices.mount.driver, AlpacaMount)
    assert isinstance(devices.camera.driver, ZwoCamera)
    assert isinstance(devices.focuser.driver, AlpacaFocuser)
    for device in (devices.mount, devices.camera, devices.focuser):
        assert device.mode is ObservatoryMode.real
    assert "zwoasi" not in sys.modules


def test_real_mode_reaches_the_configured_alpaca_devices(hardware):
    devices = build_devices(
        load_config(
            {
                **hardware,
                "DARKVIEW_AGENT_ALPACA_PORT": "32323",
                "DARKVIEW_AGENT_ALPACA_MOUNT_DEVICE": "1",
                "DARKVIEW_AGENT_ALPACA_FOCUSER_DEVICE": "2",
            }
        )
    )
    assert devices.mount.driver._alpaca._base == "/api/v1/telescope/1"
    assert devices.focuser.driver._alpaca._base == "/api/v1/focuser/2"


def test_real_mode_solves_with_astap_and_the_simulator_with_its_own(hardware):
    assert isinstance(build_solver(load_config(hardware)), AstapSolver)
    assert isinstance(build_solver(load_config({})), SimSolver)


@pytest.mark.parametrize("missing", ["DARKVIEW_AGENT_ZWO_SDK_PATH", "DARKVIEW_AGENT_ASTAP_PATH"])
def test_real_mode_without_a_required_path_refuses_and_names_it(hardware, missing):
    """And does not fall back to the simulator: an attended operator must never be
    shown simulated output as if it were hardware."""
    config = load_config({k: v for k, v in hardware.items() if k != missing})
    with pytest.raises(ConfigurationError, match=missing):
        build_devices(config)
        build_solver(config)


@pytest.mark.parametrize("name", ["DARKVIEW_AGENT_ZWO_SDK_PATH", "DARKVIEW_AGENT_ASTAP_PATH"])
def test_a_path_that_is_not_there_is_refused(hardware, tmp_path, name):
    config = load_config({**hardware, name: str(tmp_path / "absent")})
    with pytest.raises(ConfigurationError, match="does not exist"):
        build_devices(config)
        build_solver(config)


def test_a_missing_binding_says_how_to_install_it(hardware, monkeypatch):
    monkeypatch.setattr(runtime.importlib.util, "find_spec", lambda name, *a: None)
    with pytest.raises(ConfigurationError, match=r"darkview-agent\[hardware\]"):
        build_devices(load_config(hardware))


def test_real_devices_are_never_built_for_an_unattended_config(hardware):
    """`load_config` refuses this first; a hand-built config is refused here too."""
    with pytest.raises(ConfigurationError):
        build_devices(AgentConfig(driver_mode=DriverMode.REAL, attended=False))


def test_the_solver_is_told_the_field_of_the_fitted_optics():
    native = field_height_degrees(OpticalConfig.f10_native)
    assert native == pytest.approx(math.degrees(6.264 / 2032))
    assert field_height_degrees(OpticalConfig.f20_barlow) == pytest.approx(native / 2)


def test_startup_logs_the_driver_mode_and_unmeasured_envelope(caplog):
    """Acceptance criterion 3 and 4: start-up says what it selected and its safety posture."""
    with caplog.at_level(logging.INFO, logger="darkview.agent"):
        start(load_config({}))

    messages = " ".join(record.getMessage() for record in caplog.records)
    assert "driver_mode=SIMULATED" in messages
    assert "UNMEASURED" in messages
    assert "SAFETY_ENVELOPE_UNMEASURED" in messages


def test_simulated_mount_parks():
    mount = SimMount()
    mount.connect()
    mount.unpark()
    assert mount.status().parked is False

    mount.park()
    assert mount.status().parked is True
