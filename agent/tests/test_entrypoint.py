"""What `python -m darkview_agent` refuses to do.

The entrypoint is the only part of the agent that reads the real environment and
turns a real loop, so it is the only part that can start the process in a state
nothing else can recover from. These tests are about the states it refuses.

They never run the loop. `main()` returns before `run()` in every case here, and
that is the assertion: an agent in one of these states does not start.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from darkview_agent import __main__ as entrypoint
from darkview_agent.__main__ import main

COMPLETE = {
    "DARKVIEW_AGENT_OBSERVATORY_ID": str(uuid4()),
    "DARKVIEW_AGENT_CLOUD_URL": "wss://cloud.example/ws/agent",
    "DARKVIEW_AGENT_DEVICE_TOKEN": "a-device-token",
}


@pytest.fixture(autouse=True)
def no_real_setup_file(monkeypatch, tmp_path):
    """A developer's own ~/.darkview/agent.env must never decide these tests."""
    monkeypatch.setenv("DARKVIEW_AGENT_ENV_FILE", str(tmp_path / "agent.env"))


def clear_agent_environment(monkeypatch) -> None:
    for name in (
        "DARKVIEW_AGENT_OBSERVATORY_ID",
        "DARKVIEW_AGENT_CLOUD_URL",
        "DARKVIEW_AGENT_DEVICE_TOKEN",
        "DARKVIEW_AGENT_DRIVER_MODE",
        "DARKVIEW_AGENT_ATTENDED",
        "DARKVIEW_AGENT_SITE_LATITUDE",
        "DARKVIEW_AGENT_SITE_LONGITUDE",
    ):
        monkeypatch.delenv(name, raising=False)


def test_an_agent_that_cannot_dial_out_does_not_start(monkeypatch):
    """Not a degraded mode. An observatory that cannot be reached is one nobody
    can tell to park, and it would still be holding a telescope."""
    clear_agent_environment(monkeypatch)

    assert main([]) == 2


def test_each_missing_credential_on_its_own_is_enough_to_refuse(monkeypatch):
    for missing in COMPLETE:
        clear_agent_environment(monkeypatch)
        for name, value in COMPLETE.items():
            if name != missing:
                monkeypatch.setenv(name, value)

        assert main([]) == 2, f"started without {missing}"


def test_real_drivers_without_an_attending_operator_do_not_start(monkeypatch):
    """DV-020 criterion 3, at the process boundary rather than in a function.

    `load_config` raises and `main` reports it. There is no path through this
    file that reaches the hardware in an unattended process.
    """
    clear_agent_environment(monkeypatch)
    for name, value in COMPLETE.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("DARKVIEW_AGENT_DRIVER_MODE", "REAL")

    assert main([]) == 2


def test_a_malformed_observatory_id_does_not_start(monkeypatch):
    clear_agent_environment(monkeypatch)
    for name, value in COMPLETE.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("DARKVIEW_AGENT_OBSERVATORY_ID", "the-one-on-the-roof")

    assert main([]) == 2


# DV-123 criterion 5: the setup file, and the process environment above it.


def _write(path, values: dict[str, str]) -> None:
    path.write_text("".join(f"{name}={value}\n" for name, value in values.items()))


def _started_with(monkeypatch) -> list:
    """Stand in for the loop, and record the configuration it was handed."""
    seen = []
    monkeypatch.setattr(entrypoint, "run", lambda config, stop: seen.append(config))
    monkeypatch.setattr(entrypoint.signal, "signal", lambda *_: None)
    return seen


def test_the_setup_file_is_enough_to_start(monkeypatch, tmp_path):
    clear_agent_environment(monkeypatch)
    _write(tmp_path / "agent.env", COMPLETE)
    seen = _started_with(monkeypatch)

    assert main([]) == 0
    assert str(seen[0].observatory_id) == COMPLETE["DARKVIEW_AGENT_OBSERVATORY_ID"]


def test_the_process_environment_overrides_the_setup_file(monkeypatch, tmp_path):
    clear_agent_environment(monkeypatch)
    _write(tmp_path / "agent.env", COMPLETE)
    monkeypatch.setenv("DARKVIEW_AGENT_CLOUD_URL", "wss://override.example/ws/agent")
    seen = _started_with(monkeypatch)

    assert main([]) == 0
    assert seen[0].cloud_url == "wss://override.example/ws/agent"


@pytest.mark.parametrize("forbidden", ["DARKVIEW_AGENT_DRIVER_MODE", "DARKVIEW_AGENT_ATTENDED"])
def test_a_setup_file_selecting_real_hardware_does_not_start(monkeypatch, tmp_path, forbidden):
    """DV-123 criterion 4. Even with the attended flag written beside it: a file
    outlives the operator who stood next to the telescope."""
    clear_agent_environment(monkeypatch)
    _write(
        tmp_path / "agent.env",
        {**COMPLETE, "DARKVIEW_AGENT_DRIVER_MODE": "REAL", forbidden: "true"}
        if forbidden == "DARKVIEW_AGENT_ATTENDED"
        else {**COMPLETE, forbidden: "REAL"},
    )
    seen = _started_with(monkeypatch)

    assert main([]) == 2
    assert seen == []


def test_a_malformed_setup_file_is_refused_without_quoting_it(monkeypatch, tmp_path, caplog):
    clear_agent_environment(monkeypatch)
    (tmp_path / "agent.env").write_text("the-secret-token-on-a-bad-line\n")

    assert main([]) == 2
    assert "the-secret-token-on-a-bad-line" not in caplog.text
    assert "line 1" in caplog.text
