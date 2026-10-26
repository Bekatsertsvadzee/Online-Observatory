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


def test_the_hardware_settings_default_to_ascom_remote_on_loopback():
    config = load_config({})
    assert (config.alpaca_host, config.alpaca_port) == ("127.0.0.1", 11111)
    assert (config.mount_device_number, config.focuser_device_number) == (0, 0)
    assert config.zwo_sdk_path is None and config.astap_path is None
    assert config.zwo_camera_index is None and config.astap_database_dir is None


def test_the_hardware_settings_are_read():
    config = load_config(
        {
            "DARKVIEW_AGENT_ALPACA_HOST": "::1",
            "DARKVIEW_AGENT_ALPACA_PORT": "32323",
            "DARKVIEW_AGENT_ALPACA_MOUNT_DEVICE": "1",
            "DARKVIEW_AGENT_ALPACA_FOCUSER_DEVICE": "2",
            "DARKVIEW_AGENT_ZWO_SDK_PATH": r"C:\ZWO\ASICamera2.dll",
            "DARKVIEW_AGENT_ZWO_CAMERA_INDEX": "1",
            "DARKVIEW_AGENT_ASTAP_PATH": r"C:\Program Files\astap\astap_cli.exe",
            "DARKVIEW_AGENT_ASTAP_DATABASE_DIR": r"C:\Program Files\astap",
        }
    )
    assert config.alpaca_host == "::1"
    assert config.alpaca_port == 32323
    assert (config.mount_device_number, config.focuser_device_number) == (1, 2)
    assert config.zwo_sdk_path == Path(r"C:\ZWO\ASICamera2.dll")
    assert config.zwo_camera_index == 1
    assert config.astap_path == Path(r"C:\Program Files\astap\astap_cli.exe")
    assert config.astap_database_dir == Path(r"C:\Program Files\astap")


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.20", "localhost", "observatory.local"])
def test_an_alpaca_host_that_is_not_loopback_does_not_load(host):
    with pytest.raises(ConfigurationError, match="DARKVIEW_AGENT_ALPACA_HOST"):
        load_config({"DARKVIEW_AGENT_ALPACA_HOST": host})


@pytest.mark.parametrize(
    ("name", "raw"),
    [
        ("DARKVIEW_AGENT_ALPACA_PORT", "eleven"),
        ("DARKVIEW_AGENT_ALPACA_PORT", "0"),
        ("DARKVIEW_AGENT_ALPACA_PORT", "70000"),
        ("DARKVIEW_AGENT_ALPACA_MOUNT_DEVICE", "-1"),
        ("DARKVIEW_AGENT_ALPACA_FOCUSER_DEVICE", "one"),
        ("DARKVIEW_AGENT_ZWO_CAMERA_INDEX", "-2"),
    ],
)
def test_a_malformed_number_does_not_load_and_is_named(name, raw):
    with pytest.raises(ConfigurationError, match=name):
        load_config({name: raw})
