"""Guided first-run setup, and a self-test of the install (DV-123).

    python -m darkview_agent setup           ask, check each answer, write the file
    python -m darkview_agent setup --check   prove the install on the simulator

A partner owner (ADR-013) installs the agent on a machine of their own. Before
this they exported eight variables by hand, with the rules for each only in the
README. Setup asks for the same values, checks each with the rule `load_config`
applies, and writes them where the agent reads them.

Three things it never does:

- **Show the device token.** Read without echo, and absent from every prompt,
  error and summary. Log files get copied into issue reports.
- **Write DRIVER_MODE or ATTENDED.** `read_env_file` refuses a file carrying
  either, so a file cannot put an unattended start on real hardware.
- **Ask for MAX_ALT_SAFE.** It is measured, and it arrives from the cloud.

`--check` touches only the simulator and never dials the cloud. It proves the
file loads, the credentials are all present, the URL is `wss://`, and the device
layer can connect, expose, return a frame and park.
"""

from __future__ import annotations

import getpass
import os
import sys
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from contracts.models import OpticalConfig
from darkview_agent.clock import SystemClock
from darkview_agent.config import (
    ConfigurationError,
    _optical_config,
    _site,
    env_file_path,
    load_config,
    resolve_environment,
)
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount

Ask = Callable[[str], str]
Say = Callable[[str], None]

#: Long enough to be a real exposure through the simulator's clock, short enough
#: that a self-test does not make anyone wait.
CHECK_EXPOSURE_MILLISECONDS = 50.0
CHECK_TIMEOUT_SECONDS = 5.0


def _observatory_id_answer(answer: str) -> str:
    try:
        return str(uuid.UUID(answer))
    except ValueError:
        raise ConfigurationError(
            "That is not a UUID. It is the observatory id Darkview gave you when your "
            "node was registered."
        ) from None


def _cloud_url_answer(answer: str) -> str:
    if not answer.startswith(("wss://", "ws://")):
        raise ConfigurationError("The cloud URL starts with wss:// and ends in /ws/agent.")
    return answer


def _token_answer(answer: str) -> str:
    if not answer:
        raise ConfigurationError("The device token is required. It is never shown back.")
    return answer


def _optical_answer(answer: str) -> str:
    return _optical_config({"DARKVIEW_AGENT_OPTICAL_CONFIG": answer}).value


def _ask_until_valid(ask: Ask, say: Say, prompt: str, check: Callable[[str], str]) -> str:
    while True:
        try:
            return check(ask(prompt).strip())
        except ConfigurationError as error:
            say(str(error))


def _ask_site(ask: Ask, say: Say) -> dict[str, str]:
    """Both coordinates or neither, checked together by `_site`."""
    while True:
        latitude = ask("Site latitude in degrees (blank if not yet surveyed): ").strip()
        longitude = ask("Site longitude in degrees (blank if not yet surveyed): ").strip()
        try:
            site = _site(
                {
                    "DARKVIEW_AGENT_SITE_LATITUDE": latitude,
                    "DARKVIEW_AGENT_SITE_LONGITUDE": longitude,
                }
            )
        except ConfigurationError as error:
            say(str(error))
            continue
        if site is None:
            say(
                "No site coordinates: the Sun cannot be computed, so every slew will be "
                "refused until they are set."
            )
            return {}
        return {
            "DARKVIEW_AGENT_SITE_LATITUDE": latitude,
            "DARKVIEW_AGENT_SITE_LONGITUDE": longitude,
        }


def write_env_file(path: Path, values: dict[str, str]) -> None:
    """Atomically, and readable by this user alone from the first byte.

    The temporary file is created `0600` rather than chmodded after writing, so
    there is no moment at which the token sits in a file anyone else can read.
    """
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    body = "".join(f"{name}={value}\n" for name, value in values.items())

    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".agent.env.")
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(body)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def run_setup(path: Path, ask: Ask, ask_secret: Ask, say: Say) -> int:
    say("Darkview Observatory Agent setup. Nothing here selects real hardware.")

    values = {
        "DARKVIEW_AGENT_OBSERVATORY_ID": _ask_until_valid(
            ask, say, "Observatory id: ", _observatory_id_answer
        ),
        "DARKVIEW_AGENT_CLOUD_URL": _ask_until_valid(
            ask, say, "Cloud URL (wss://.../ws/agent): ", _cloud_url_answer
        ),
        "DARKVIEW_AGENT_DEVICE_TOKEN": _ask_until_valid(
            ask_secret, say, "Device token (not shown): ", _token_answer
        ),
    }
    values.update(_ask_site(ask, say))
    optics = ", ".join(option.value for option in OpticalConfig)
    values["DARKVIEW_AGENT_OPTICAL_CONFIG"] = _ask_until_valid(
        ask,
        say,
        f"Optical configuration ({optics}; blank for F10_NATIVE): ",
        _optical_answer,
    )

    write_env_file(path, values)
    say(f"Wrote {path} (readable by you only). Device token: set, not shown.")
    say("Run `python -m darkview_agent setup --check` to test the install.")
    return 0


def run_check(process_environment: dict[str, str], say: Say) -> int:
    try:
        config = load_config(resolve_environment(process_environment))
    except ConfigurationError as error:
        say(f"FAIL configuration: {error}")
        return 2

    failures: list[str] = []
    if not config.can_dial_out:
        failures.append(
            "credentials: the observatory id, cloud URL and device token must all be set"
        )
    if config.cloud_url and not config.cloud_url.startswith("wss://"):
        failures.append("cloud URL: must be wss:// -- the link is never unencrypted")

    try:
        _exercise_simulator()
    except Exception as error:  # noqa: BLE001 - reported, and the check fails
        failures.append(f"simulator: {type(error).__name__}: {error}")

    for failure in failures:
        say(f"FAIL {failure}")
    if failures:
        return 2

    say(f"OK configuration loaded from {env_file_path(process_environment)}")
    say("OK credentials present; cloud URL is wss://")
    say("OK simulator: mount, camera and focuser connected; one frame exposed; mount parked")
    return 0


def _exercise_simulator() -> None:
    clock = SystemClock()
    mount = SimMount(clock)
    camera = SimCamera(clock, mount=mount)
    focuser = SimFocuser(clock)
    for device in (mount, camera, focuser):
        device.connect()
    try:
        camera.expose(CHECK_EXPOSURE_MILLISECONDS, gain=0)
        deadline = clock.monotonic() + CHECK_TIMEOUT_SECONDS
        while not camera.exposure_complete():
            if clock.monotonic() > deadline:
                raise TimeoutError("the simulated exposure never completed")
            time.sleep(0.01)
        frame = camera.read_frame()
        if frame.pixels.size == 0:
            raise ValueError("the simulated camera returned an empty frame")
        mount.park()
    finally:
        for device in (focuser, camera, mount):
            device.disconnect()


def main(arguments: list[str]) -> int:
    environment = dict(os.environ)
    if arguments == ["--check"]:
        return run_check(environment, print)
    if arguments:
        print("usage: python -m darkview_agent setup [--check]", file=sys.stderr)
        return 2
    return run_setup(env_file_path(environment), input, getpass.getpass, print)
