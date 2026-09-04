"""What `python -m darkview_agent` refuses to do.

The entrypoint is the only part of the agent that reads the real environment and
turns a real loop, so it is the only part that can start the process in a state
nothing else can recover from. These tests are about the states it refuses.

They never run the loop. `main()` returns before `run()` in every case here, and
that is the assertion: an agent in one of these states does not start.
"""

from __future__ import annotations

from uuid import uuid4

from darkview_agent.__main__ import main

COMPLETE = {
    "DARKVIEW_AGENT_OBSERVATORY_ID": str(uuid4()),
    "DARKVIEW_AGENT_CLOUD_URL": "wss://cloud.example/ws/agent",
    "DARKVIEW_AGENT_DEVICE_TOKEN": "a-device-token",
}


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

    assert main() == 2


def test_each_missing_credential_on_its_own_is_enough_to_refuse(monkeypatch):
    for missing in COMPLETE:
        clear_agent_environment(monkeypatch)
        for name, value in COMPLETE.items():
            if name != missing:
                monkeypatch.setenv(name, value)

        assert main() == 2, f"started without {missing}"


def test_real_drivers_without_an_attending_operator_do_not_start(monkeypatch):
    """DV-020 criterion 3, at the process boundary rather than in a function.

    `load_config` raises and `main` reports it. There is no path through this
    file that reaches the hardware in an unattended process.
    """
    clear_agent_environment(monkeypatch)
    for name, value in COMPLETE.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("DARKVIEW_AGENT_DRIVER_MODE", "REAL")

    assert main() == 2


def test_a_malformed_observatory_id_does_not_start(monkeypatch):
    clear_agent_environment(monkeypatch)
    for name, value in COMPLETE.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("DARKVIEW_AGENT_OBSERVATORY_ID", "the-one-on-the-roof")

    assert main() == 2
