"""DV-123: guided first-run setup, and the install self-test.

Driven through injected prompts, so every answer is chosen and nothing waits on
a terminal. The self-test runs the real simulator; nothing here reaches hardware
or the network.
"""

from __future__ import annotations

import os
import socket
import stat
from pathlib import Path
from uuid import uuid4

import psutil
import pytest

from darkview_agent import setup
from darkview_agent.config import read_env_file

OBSERVATORY_ID = str(uuid4())
TOKEN = "dv-token-that-must-never-be-shown"


class Terminal:
    """Scripted answers, and everything said back."""

    def __init__(self, answers: list[str], secrets: list[str]) -> None:
        self.answers = list(answers)
        self.secrets = list(secrets)
        self.prompts: list[str] = []
        self.said: list[str] = []

    def ask(self, prompt: str) -> str:
        self.prompts.append(prompt)
        return self.answers.pop(0)

    def ask_secret(self, prompt: str) -> str:
        self.prompts.append(prompt)
        return self.secrets.pop(0)

    def say(self, line: str) -> None:
        self.said.append(line)

    @property
    def everything_shown(self) -> str:
        return "\n".join(self.prompts + self.said)


def run(tmp_path: Path, answers: list[str], secrets: list[str] | None = None):
    terminal = Terminal(answers, secrets if secrets is not None else [TOKEN])
    path = tmp_path / "darkview" / "agent.env"
    code = setup.run_setup(path, terminal.ask, terminal.ask_secret, terminal.say)
    return code, path, terminal


GOOD = [OBSERVATORY_ID, "wss://cloud.example/ws/agent", "41.7151", "44.8271", ""]


# criterion 1


def test_writes_every_answer_under_the_name_the_agent_reads(tmp_path):
    code, path, _ = run(tmp_path, GOOD)

    assert code == 0
    assert read_env_file(path) == {
        "DARKVIEW_AGENT_OBSERVATORY_ID": OBSERVATORY_ID,
        "DARKVIEW_AGENT_CLOUD_URL": "wss://cloud.example/ws/agent",
        "DARKVIEW_AGENT_DEVICE_TOKEN": TOKEN,
        "DARKVIEW_AGENT_SITE_LATITUDE": "41.7151",
        "DARKVIEW_AGENT_SITE_LONGITUDE": "44.8271",
        "DARKVIEW_AGENT_OPTICAL_CONFIG": "F10_NATIVE",
    }


def test_asks_again_after_an_answer_the_rules_refuse(tmp_path):
    answers = [
        "the-one-on-the-roof", OBSERVATORY_ID,
        "https://cloud.example", "wss://cloud.example/ws/agent",
        "41.7151", "", "41.7151", "44.8271",
        "F99_MADE_UP", "F20_BARLOW",
    ]
    code, path, terminal = run(tmp_path, answers)

    assert code == 0
    assert any("not a UUID" in line for line in terminal.said)
    assert any("wss://" in line for line in terminal.said)
    assert any("must be set together" in line for line in terminal.said)
    assert any("not an optical configuration" in line for line in terminal.said)
    assert read_env_file(path)["DARKVIEW_AGENT_OPTICAL_CONFIG"] == "F20_BARLOW"


def test_a_site_not_yet_surveyed_is_left_out_and_said_so(tmp_path):
    code, path, terminal = run(tmp_path, [OBSERVATORY_ID, "wss://c.example/ws/agent", "", "", ""])

    assert code == 0
    assert "DARKVIEW_AGENT_SITE_LATITUDE" not in read_env_file(path)
    assert any("every slew will be refused" in line for line in terminal.said)


# criterion 2


def test_the_token_is_asked_without_echo_and_never_shown(tmp_path):
    code, path, terminal = run(tmp_path, GOOD, secrets=["", TOKEN])

    assert code == 0
    assert terminal.secrets == []  # both token prompts went to the no-echo reader
    assert TOKEN not in terminal.everything_shown
    assert any("required" in line for line in terminal.said)


def test_the_real_prompt_reads_the_token_through_getpass(monkeypatch, tmp_path):
    monkeypatch.setenv("DARKVIEW_AGENT_ENV_FILE", str(tmp_path / "agent.env"))
    answers = iter(GOOD)
    secret_prompts = []
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    monkeypatch.setattr(
        setup.getpass, "getpass", lambda prompt: secret_prompts.append(prompt) or TOKEN
    )

    assert setup.main([]) == 0
    assert secret_prompts and "token" in secret_prompts[0].lower()


# criterion 3


def test_the_file_is_readable_by_its_owner_alone(tmp_path):
    _, path, _ = run(tmp_path, GOOD)

    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_rewriting_leaves_no_temporary_file_behind(tmp_path):
    run(tmp_path, GOOD)
    run(tmp_path, GOOD)

    assert sorted(p.name for p in (tmp_path / "darkview").iterdir()) == ["agent.env"]


def test_a_failed_write_leaves_the_previous_file_intact(tmp_path, monkeypatch):
    _, path, _ = run(tmp_path, GOOD)
    before = path.read_text()

    def refuse(*_):
        raise OSError("disk full")

    monkeypatch.setattr(setup.os, "replace", refuse)
    with pytest.raises(OSError):
        run(tmp_path, GOOD)

    assert path.read_text() == before
    assert sorted(p.name for p in path.parent.iterdir()) == ["agent.env"]


# criterion 4


def test_setup_never_writes_real_hardware_settings(tmp_path):
    _, path, _ = run(tmp_path, GOOD)

    body = path.read_text()
    assert "DRIVER_MODE" not in body
    assert "ATTENDED" not in body
    assert "MAX_ALT" not in body


# criterion 6


@pytest.fixture
def installed(tmp_path, monkeypatch):
    for name in list(os.environ):
        if name.startswith("DARKVIEW_AGENT_"):
            monkeypatch.delenv(name)
    _, path, _ = run(tmp_path, GOOD)
    return {"DARKVIEW_AGENT_ENV_FILE": str(path)}


def check(environment: dict[str, str]) -> tuple[int, list[str]]:
    said: list[str] = []
    return setup.run_check(environment, said.append), said


def test_the_check_passes_a_good_install_on_the_simulator(installed):
    code, said = check(installed)

    assert code == 0, said
    assert any("frame exposed" in line and "parked" in line for line in said)
    assert TOKEN not in "\n".join(said)


def test_the_check_refuses_an_unencrypted_cloud_url(installed):
    code, said = check({**installed, "DARKVIEW_AGENT_CLOUD_URL": "ws://cloud.example/ws/agent"})

    assert code == 2
    assert any(line.startswith("FAIL cloud URL") for line in said)


def test_the_check_refuses_missing_credentials(tmp_path):
    code, said = check({"DARKVIEW_AGENT_ENV_FILE": str(tmp_path / "absent.env")})

    assert code == 2
    assert any(line.startswith("FAIL credentials") for line in said)


def test_the_check_refuses_a_file_selecting_real_hardware(installed):
    path = Path(installed["DARKVIEW_AGENT_ENV_FILE"])
    path.write_text(path.read_text() + "DARKVIEW_AGENT_DRIVER_MODE=REAL\n")

    code, said = check(installed)

    assert code == 2
    assert any(line.startswith("FAIL configuration") for line in said)


def test_the_check_reports_a_simulator_that_cannot_expose(installed, monkeypatch):
    def broken(*_args, **_kwargs):
        raise RuntimeError("camera unplugged")

    monkeypatch.setattr(setup.SimCamera, "expose", broken)
    code, said = check(installed)

    assert code == 2
    assert any("camera unplugged" in line for line in said)


def test_the_check_listens_on_nothing_and_dials_nothing(installed, monkeypatch):
    """ADR-013: an installed agent has no reachable address. Its self-test has no
    reason to open a socket in either direction."""
    process = psutil.Process(os.getpid())

    def listening() -> set:
        return {
            c.laddr for c in process.net_connections(kind="inet") if c.status == psutil.CONN_LISTEN
        }

    before = listening()

    def no_dialling(*_args, **_kwargs):
        raise AssertionError("the self-test opened a network connection")

    monkeypatch.setattr(socket, "create_connection", no_dialling)
    monkeypatch.setattr(socket.socket, "connect", no_dialling)

    code, _ = check(installed)

    assert code == 0
    assert listening() == before
