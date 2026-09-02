"""Acceptance criterion 5 of DV-022: no simulator code path can reach a real device.

The claim being defended is narrow and important. The simulator is the default
implementation, so it runs constantly — in CI, in every developer's test run, in
every background session. If any part of it could open a serial port, an Alpaca
HTTP connection or a ZWO SDK handle, then "running the tests" would become an
action that can move a real telescope.

This is proved two ways: by walking the transitive import graph of the simulator
and asserting no hardware-capable module appears in it, and by importing the
simulator with those modules forcibly absent from the import path.
"""

from __future__ import annotations

import builtins
import importlib
import sys

import pytest

# Modules that can reach hardware or the network a device sits on. If a real
# driver later legitimately needs one, it belongs in that driver's module — never
# in anything the simulator imports.
HARDWARE_CAPABLE_MODULES = {
    "serial",
    "usb",
    "zwoasi",
    "alpaca",
    "alpyca",
    "win32com",
    "pythoncom",
    "socket",
    "http",
    "urllib",
    "requests",
    "httpx",
    "aiohttp",
    "websockets",
    "subprocess",
    "ctypes",
}

SIMULATOR_MODULES = (
    "darkview_agent.devices.base",
    "darkview_agent.devices.frame",
    "darkview_agent.devices.simulated",
    "darkview_agent.devices.starfield",
    "darkview_agent.clock",
)


def transitive_imports(module_name: str) -> set[str]:
    """Every module reachable from this one, following only our own packages.

    Third-party internals are not walked — numpy imports plenty, and the claim
    is about our code choosing to reach hardware, not about numpy's internals.
    """
    seen: set[str] = set()
    pending = [module_name]

    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)

        module = importlib.import_module(current)
        for attribute in vars(module).values():
            candidate = getattr(attribute, "__module__", None)
            if isinstance(candidate, str):
                seen.add(candidate)
        for name in getattr(module, "__dict__", {}):
            value = module.__dict__[name]
            candidate_module = getattr(value, "__name__", None)
            if isinstance(candidate_module, str) and candidate_module.startswith(
                "darkview_agent"
            ):
                pending.append(candidate_module)

    return seen


def test_simulator_imports_nothing_hardware_capable():
    reachable: set[str] = set()
    for module_name in SIMULATOR_MODULES:
        reachable |= transitive_imports(module_name)

    # Compare on the top-level package of each reachable module.
    top_level = {name.split(".")[0] for name in reachable}
    offences = top_level & HARDWARE_CAPABLE_MODULES

    assert not offences, (
        "The simulator can reach hardware-capable modules: "
        f"{sorted(offences)}. The simulator runs in CI and in every background "
        "session; it must never be able to command a real device."
    )


def test_simulator_works_with_hardware_modules_absent_from_the_import_path():
    """Import and exercise the simulator while every hardware module is blocked."""
    real_import = builtins.__import__
    blocked: list[str] = []

    def blocking_import(name, globals=None, locals=None, fromlist=(), level=0):
        top_level = name.split(".")[0]
        if top_level in HARDWARE_CAPABLE_MODULES:
            blocked.append(name)
            raise ImportError(f"{name} is blocked by test_simulator_isolation")
        return real_import(name, globals, locals, fromlist, level)

    for module_name in SIMULATOR_MODULES:
        sys.modules.pop(module_name, None)

    builtins.__import__ = blocking_import
    try:
        clock_module = importlib.import_module("darkview_agent.clock")
        simulated = importlib.import_module("darkview_agent.devices.simulated")

        clock = clock_module.ManualClock()
        mount = simulated.SimMount(clock=clock)
        mount.connect()
        mount.unpark()
        mount.slew_to(40.0, 90.0)
        clock.advance(600.0)
        assert mount.status().slewing is False

        camera = simulated.SimCamera(clock=clock, mount=mount, width_px=64, height_px=64)
        camera.connect()
        camera.expose(500.0, 100)
        clock.advance(1.0)
        frame = camera.read_frame()
        assert frame.width_px == 64

        focuser = simulated.SimFocuser(clock=clock)
        focuser.connect()
        focuser.move_to(16000)
        clock.advance(600.0)
        assert focuser.status().position == 16000
    finally:
        builtins.__import__ = real_import
        for module_name in SIMULATOR_MODULES:
            sys.modules.pop(module_name, None)
        importlib.import_module("darkview_agent.devices.simulated")

    assert blocked == [], f"the simulator tried to import blocked modules: {blocked}"


def test_the_blocking_guard_actually_blocks():
    """A guard that blocks nothing would let this test file pass for free."""
    real_import = builtins.__import__

    def blocking_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name.split(".")[0] in HARDWARE_CAPABLE_MODULES:
            raise ImportError(f"{name} is blocked")
        return real_import(name, globals, locals, fromlist, level)

    builtins.__import__ = blocking_import
    try:
        with pytest.raises(ImportError):
            importlib.import_module("serial")
    finally:
        builtins.__import__ = real_import
