import logging

import pytest

from darkview_agent.config import AgentConfig, ConfigurationError, DriverMode, load_config
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.runtime import build_devices, start


def test_default_startup_selects_simulated_devices():
    devices = build_devices(load_config({}))
    assert isinstance(devices.mount, SimMount)
    assert isinstance(devices.camera, SimCamera)
    assert isinstance(devices.focuser, SimFocuser)


def test_real_mode_does_not_silently_fall_back_to_the_simulator():
    """An attended operator must never be shown simulated output as if it were hardware."""
    config = AgentConfig(driver_mode=DriverMode.REAL, attended=True)
    with pytest.raises(ConfigurationError) as raised:
        build_devices(config)
    assert "Refusing to fall back to the simulator" in str(raised.value)


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
