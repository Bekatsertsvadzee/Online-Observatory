"""Acceptance criterion 1 of DV-021: the agent opens no listening socket.

This is the architectural guarantee the whole security model rests on. The
observatory accepts no inbound connection from the internet or the LAN; it dials
out and keeps a heartbeat. If the agent ever bound a port, the observatory would
become addressable, and every other control — session ownership, command expiry,
the safety envelope — would sit behind a door that could be knocked on directly.

Checked two ways: by inspecting the live process's sockets, and by asserting no
module the agent imports calls a bind or listen primitive.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path

import psutil
import pytest

from darkview_agent.clock import ManualClock
from darkview_agent.config import load_config
from darkview_agent.link.session import LinkSession
from darkview_agent.runtime import start
from tests.fake_transport import Connector

AGENT_PACKAGE = Path(__file__).resolve().parents[1] / "darkview_agent"

# Socket operations that would make this process addressable.
LISTENING_PRIMITIVES = {"bind", "listen"}


def listening_ports() -> list[int]:
    process = psutil.Process(os.getpid())
    return sorted(
        connection.laddr.port
        for connection in process.net_connections(kind="inet")
        if connection.status == psutil.CONN_LISTEN
    )


def test_the_process_has_no_listening_ports_after_agent_start_up():
    """Criterion 1, on the live process."""
    before = listening_ports()

    devices = start(load_config({}))
    assert devices is not None

    clock, connector = ManualClock(), Connector()
    session = LinkSession(
        observatory_id=__import__("uuid").uuid4(),
        agent_version="0.1.0",
        connect=connector,
        clock=clock,
    )
    session.pump()
    connector.current.deliver_welcome()
    session.pump()
    assert session.is_online

    after = listening_ports()
    opened = sorted(set(after) - set(before))

    assert opened == [], f"the agent opened listening port(s): {opened}"


def test_the_check_can_actually_see_a_listening_port():
    """A detector that sees nothing would let the test above pass for free."""
    import socket

    before = set(listening_ports())
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        assert set(listening_ports()) - before, "psutil did not see a bound port"
    finally:
        server.close()


def calls_listening_primitive(path: Path) -> list[str]:
    """Find bind() or listen() calls in one module."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError, OSError):
        return []

    found: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        name = None
        if isinstance(function, ast.Attribute):
            name = function.attr
        elif isinstance(function, ast.Name):
            name = function.id
        if name in LISTENING_PRIMITIVES:
            found.append(f"{path.name}:{node.lineno}: {name}()")
    return found


@pytest.mark.parametrize(
    "module_path",
    sorted(AGENT_PACKAGE.rglob("*.py")),
    ids=lambda path: str(path.relative_to(AGENT_PACKAGE)),
)
def test_no_agent_module_binds_or_listens(module_path: Path):
    offences = calls_listening_primitive(module_path)
    assert not offences, (
        "The agent must never bind or listen. The observatory dials out and is "
        f"not addressable: {offences}"
    )


def test_the_source_check_detects_a_bind(tmp_path):
    candidate = tmp_path / "listener.py"
    candidate.write_text(
        "import socket\ns = socket.socket()\ns.bind(('0.0.0.0', 8080))\ns.listen(5)\n",
        encoding="utf-8",
    )
    found = calls_listening_primitive(candidate)
    assert len(found) == 2, f"expected to catch bind and listen, got {found}"
