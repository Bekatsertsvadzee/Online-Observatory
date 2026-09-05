from pathlib import Path
from uuid import uuid4

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


def test_the_observatory_id_is_parsed_and_a_bad_one_refuses_to_start():
    identifier = uuid4()
    config = load_config({"DARKVIEW_AGENT_OBSERVATORY_ID": str(identifier)})
    assert config.observatory_id == identifier

    with pytest.raises(ConfigurationError) as raised:
        load_config({"DARKVIEW_AGENT_OBSERVATORY_ID": "observatory-one"})
    assert "not a UUID" in str(raised.value)


def test_site_coordinates_are_both_or_neither():
    """Half a position computes the Sun from a place that does not exist.

    A latitude paired with a default longitude produces a confident, wrong
    answer about where the Sun is, and the Sun exclusion is the one rule that
    cannot be overridden by anyone. Refusing to start is the only safe reading.
    """
    assert load_config({}).site is None

    for partial in (
        {"DARKVIEW_AGENT_SITE_LATITUDE": "41.7151"},
        {"DARKVIEW_AGENT_SITE_LONGITUDE": "44.8271"},
    ):
        with pytest.raises(ConfigurationError) as raised:
            load_config(partial)
        assert "must be set together" in str(raised.value)


def test_site_coordinates_are_resolved_when_both_are_present():
    config = load_config(
        {
            "DARKVIEW_AGENT_SITE_LATITUDE": "41.7151",
            "DARKVIEW_AGENT_SITE_LONGITUDE": "44.8271",
        }
    )
    assert config.site is not None
    assert config.site.latitude_degrees == pytest.approx(41.7151)
    assert config.site.longitude_degrees == pytest.approx(44.8271)


def test_an_impossible_site_refuses_to_start():
    with pytest.raises(ConfigurationError):
        load_config(
            {
                "DARKVIEW_AGENT_SITE_LATITUDE": "112.0",
                "DARKVIEW_AGENT_SITE_LONGITUDE": "44.8271",
            }
        )
    with pytest.raises(ConfigurationError):
        load_config(
            {
                "DARKVIEW_AGENT_SITE_LATITUDE": "north",
                "DARKVIEW_AGENT_SITE_LONGITUDE": "44.8271",
            }
        )


def test_dialling_out_needs_all_three_of_id_url_and_token():
    """An agent that cannot reach the cloud cannot be told to stop."""
    complete = {
        "DARKVIEW_AGENT_OBSERVATORY_ID": str(uuid4()),
        "DARKVIEW_AGENT_CLOUD_URL": "wss://cloud.example/ws/agent",
        "DARKVIEW_AGENT_DEVICE_TOKEN": "a-device-token",
    }
    assert load_config(complete).can_dial_out is True

    for missing in complete:
        partial = {key: value for key, value in complete.items() if key != missing}
        assert load_config(partial).can_dial_out is False


def test_the_state_path_defaults_under_the_home_directory():
    """Not the working directory. A service started from a different folder must
    not come back with an empty memory of which commands it has already run."""
    default = load_config({}).state_path
    assert default == Path.home() / ".darkview" / "agent-state.sqlite3"


def test_the_state_path_can_be_set_and_expands_a_tilde():
    config = load_config({"DARKVIEW_AGENT_STATE_PATH": "~/observatory/state.sqlite3"})
    assert config.state_path == Path.home() / "observatory" / "state.sqlite3"
