import pytest

from darkview_agent.config import ConfigurationError, DriverMode, load_config


def test_no_configuration_selects_the_simulator():
    """Acceptance criterion 2: the default is always the simulator."""
    config = load_config({})
    assert config.driver_mode is DriverMode.SIMULATED
    assert config.is_simulated is True
    assert config.attended is False


def test_real_drivers_require_an_explicit_setting():
    """An empty or absent setting never resolves to REAL."""
    for environment in (
        {},
        {"DARKVIEW_AGENT_DRIVER_MODE": ""},
        {"DARKVIEW_AGENT_DRIVER_MODE": "   "},
    ):
        assert load_config(environment).driver_mode is DriverMode.SIMULATED


def test_real_drivers_without_attended_flag_refuse_to_start():
    """Acceptance criterion 3: real mode without an attending operator fails to start."""
    with pytest.raises(ConfigurationError) as raised:
        load_config({"DARKVIEW_AGENT_DRIVER_MODE": "REAL"})

    message = str(raised.value)
    assert "DARKVIEW_AGENT_ATTENDED" in message
    assert "operator physically present" in message


def test_real_drivers_with_attended_flag_resolve_to_real():
    config = load_config(
        {"DARKVIEW_AGENT_DRIVER_MODE": "REAL", "DARKVIEW_AGENT_ATTENDED": "true"}
    )
    assert config.driver_mode is DriverMode.REAL
    assert config.attended is True
    assert config.is_simulated is False


def test_attended_flag_alone_does_not_select_real_drivers():
    """The attended flag is permission, not selection. It never promotes on its own."""
    config = load_config({"DARKVIEW_AGENT_ATTENDED": "true"})
    assert config.driver_mode is DriverMode.SIMULATED


def test_unknown_driver_mode_is_rejected():
    with pytest.raises(ConfigurationError) as raised:
        load_config({"DARKVIEW_AGENT_DRIVER_MODE": "HARDWARE"})
    assert "is not a driver mode" in str(raised.value)
