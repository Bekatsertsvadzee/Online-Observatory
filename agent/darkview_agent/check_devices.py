"""Read-only bring-up check of the real devices, for an attended operator.

    python -m darkview_agent check-devices [--exposure-seconds 1] [--gain 0] [--solve]

Run at the observatory with `DARKVIEW_AGENT_DRIVER_MODE=REAL` and
`DARKVIEW_AGENT_ATTENDED=1` set in the process environment -- the setup file can set
neither, so this cannot run from a file left on disk. Each step prints PASS or FAIL
with its reason, and the exit code is non-zero if any failed.

What it does: asks the loopback Alpaca bridge whether it is there; connects to the
mount and focuser and reads what they report; opens the camera through the ZWO SDK,
takes one short exposure and saves it as FITS under the state folder; and with
`--solve`, runs ASTAP on that frame.

What it never does: move the mount or the focuser. No slew, park, unpark, tracking
change, abort, focuser move, halt or temperature-compensation change is sent --
only `Connected`, and only to connect a device that was not connected and then
release it. It never dials the cloud and opens no listening port. It does not need,
read or report MAX_ALT_SAFE: that is measured by hand afterwards (RUNBOOK §5).
"""

from __future__ import annotations

import argparse
import os
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

from darkview_agent import runtime
from darkview_agent.config import (
    AgentConfig,
    ConfigurationError,
    DriverMode,
    load_config,
    resolve_environment,
)
from darkview_agent.devices.alpaca import (
    REQUIRED_CAPABILITIES,
    AlpacaClient,
    Transport,
    http_transport,
)
from darkview_agent.devices.base import DeviceError
from darkview_agent.devices.zwo import ZwoCamera
from darkview_agent.mission.solver import PlateSolver
from darkview_agent.solve.astap import fits_bytes

COMMAND = "check-devices"

Say = Callable[[str], None]

#: Readout and USB transfer after the exposure itself has ended.
READOUT_ALLOWANCE_SECONDS = 30.0
POLL_SECONDS = 0.1
#: A solve with no pointing hint searches more sky than a mission's does.
CHECK_SOLVE_TIMEOUT_SECONDS = 120.0

_CAPABILITY_NAMES = {
    "canslewaltazasync": "CanSlewAltAzAsync",
    "canpark": "CanPark",
    "canunpark": "CanUnpark",
    "cansettracking": "CanSetTracking",
}


class _Report:
    def __init__(self, say: Say) -> None:
        self._say = say
        self.failed = 0

    def passed(self, step: str, detail: str) -> None:
        self._say(f"PASS {step}: {detail}")

    def fail(self, step: str, detail: str) -> None:
        self.failed += 1
        self._say(f"FAIL {step}: {detail}")


def _check_bridge(config: AgentConfig, transport: Transport, report: _Report) -> None:
    where = f"{config.alpaca_host}:{config.alpaca_port}"
    try:
        status, body = transport("GET", "/management/apiversions", {"ClientID": "1"}, 5.0)
    except DeviceError as error:
        report.fail("alpaca bridge", f"nothing answered on {where}: {error}")
        return
    if status != 200:
        report.fail("alpaca bridge", f"{where} answered HTTP {status}")
        return
    report.passed("alpaca bridge", f"answering on loopback {where}")


class _Borrowed:
    """Connect a device only if it was not already, and release only what was taken."""

    def __init__(self, client: AlpacaClient) -> None:
        self._client = client
        self._took = False

    def __enter__(self) -> AlpacaClient:
        if self._client.get("connected") is not True:
            self._client.put("connected", {"Connected": "True"})
            self._took = True
        return self._client

    def __exit__(self, *_: Any) -> None:
        if self._took:
            self._client.put("connected", {"Connected": "False"})


def _check_mount(config: AgentConfig, transport: Transport, report: _Report) -> None:
    client = AlpacaClient(
        config.alpaca_host,
        config.alpaca_port,
        "telescope",
        config.mount_device_number,
        transport=transport,
    )
    step = f"mount (telescope {config.mount_device_number})"
    try:
        with _Borrowed(client) as mount:
            report.passed(step, "connected")
            for member in REQUIRED_CAPABILITIES:
                name = _CAPABILITY_NAMES[member]
                if mount.get(member) is True:
                    report.passed(f"mount {name}", "yes")
                else:
                    report.fail(f"mount {name}", "no -- the agent's mount driver requires it")
            altitude = float(mount.get("altitude"))
            azimuth = float(mount.get("azimuth"))
            report.passed(
                "mount state",
                f"altitude {altitude:.2f} deg, azimuth {azimuth:.2f} deg, "
                f"AtPark {mount.get('atpark')}, Tracking {mount.get('tracking')}",
            )
    except DeviceError as error:
        report.fail(step, str(error))


def _optional(client: AlpacaClient, member: str) -> Any:
    try:
        return client.get(member)
    except DeviceError:
        return "not reported"


def _check_focuser(config: AgentConfig, transport: Transport, report: _Report) -> None:
    client = AlpacaClient(
        config.alpaca_host,
        config.alpaca_port,
        "focuser",
        config.focuser_device_number,
        transport=transport,
    )
    step = f"focuser (focuser {config.focuser_device_number})"
    try:
        with _Borrowed(client) as focuser:
            report.passed(step, "connected")
            if focuser.get("absolute") is not True:
                report.fail(
                    "focuser absolute",
                    "no -- relative-only focusers are refused by the agent's focuser driver",
                )
                return
            report.passed("focuser absolute", "yes")
            report.passed(
                "focuser state",
                f"position {focuser.get('position')} of MaxStep {focuser.get('maxstep')}, "
                f"MaxIncrement {focuser.get('maxincrement')}, "
                f"moving {focuser.get('ismoving')}, "
                f"temperature {_optional(focuser, 'temperature')}, "
                f"TempComp {_optional(focuser, 'tempcomp')}",
            )
    except DeviceError as error:
        report.fail(step, str(error))


def _check_camera(
    camera_factory: Callable[[], ZwoCamera],
    report: _Report,
    *,
    exposure_seconds: float,
    gain: int,
    output_dir: Path,
    monotonic: Callable[[], float],
    sleep: Callable[[float], None],
):
    try:
        camera = camera_factory()
        camera.connect()
    except (ConfigurationError, DeviceError) as error:
        report.fail("camera", str(error))
        return None

    try:
        sensor = camera.sensor
        assert sensor is not None
        report.passed(
            "camera",
            f"{sensor.name}, {sensor.width_px}x{sensor.height_px}, {sensor.bit_depth}-bit, "
            f"Bayer {sensor.bayer_pattern or 'none (mono)'}, "
            f"gain {sensor.gain_min}..{sensor.gain_max}",
        )
        camera.expose(exposure_seconds * 1000.0, gain)
        deadline = monotonic() + exposure_seconds + READOUT_ALLOWANCE_SECONDS
        while not camera.exposure_complete():
            if monotonic() > deadline:
                raise DeviceError(f"no frame {READOUT_ALLOWANCE_SECONDS:.0f}s after the exposure")
            sleep(POLL_SECONDS)
        frame = camera.read_frame()
    except (DeviceError, ValueError) as error:
        report.fail("exposure", str(error))
        return None
    finally:
        try:
            camera.disconnect()
        except DeviceError as error:
            report.fail("camera release", str(error))

    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"check-{frame.captured_at.strftime('%Y%m%dT%H%M%SZ')}.fits"
    path.write_bytes(fits_bytes(frame))
    pixels = frame.pixels
    report.passed(
        "exposure",
        f"{exposure_seconds:g}s at gain {gain}: min {int(pixels.min())}, "
        f"median {int(np.median(pixels))}, max {int(pixels.max())}; saved {path}",
    )
    return frame


def run_check_devices(
    config: AgentConfig,
    say: Say,
    *,
    exposure_seconds: float = 1.0,
    gain: int = 0,
    solve: bool = False,
    transport: Transport | None = None,
    camera_factory: Callable[[], ZwoCamera] | None = None,
    solver_factory: Callable[[], PlateSolver] | None = None,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> int:
    if config.driver_mode is not DriverMode.REAL or not config.attended:
        say(
            "FAIL configuration: check-devices talks to real hardware and runs only with "
            "DARKVIEW_AGENT_DRIVER_MODE=REAL and DARKVIEW_AGENT_ATTENDED=1 set in the "
            "process environment by an operator at the observatory."
        )
        return 2

    say(f"Device check, read-only, {now().isoformat(timespec='seconds')}. Nothing will move.")
    report = _Report(say)
    transport = transport or http_transport(config.alpaca_host, config.alpaca_port)

    _check_bridge(config, transport, report)
    _check_mount(config, transport, report)
    _check_focuser(config, transport, report)
    frame = _check_camera(
        camera_factory or (lambda: runtime.zwo_camera(config)),
        report,
        exposure_seconds=exposure_seconds,
        gain=gain,
        output_dir=config.state_path.parent / "device-check",
        monotonic=monotonic,
        sleep=sleep,
    )

    if solve:
        if frame is None:
            report.fail("plate solve", "no frame to solve")
        else:
            try:
                solver = (
                    solver_factory()
                    if solver_factory
                    else runtime.astap_solver(config, CHECK_SOLVE_TIMEOUT_SECONDS)
                )
            except ConfigurationError as error:
                report.fail("plate solve", str(error))
            else:
                result = solver.solve(frame)
                if result is None:
                    report.fail(
                        "plate solve",
                        "ASTAP found no solution (clouds, daylight, focus, too few stars, "
                        "or a missing star database -- see the agent log)",
                    )
                else:
                    report.passed(
                        "plate solve",
                        f"RA {result.right_ascension_hours:.4f} h, "
                        f"Dec {result.declination_degrees:.4f} deg",
                    )

    if report.failed:
        say(f"{report.failed} step(s) failed.")
        return 1
    say("All steps passed. Next: measure MAX_ALT_SAFE by hand (RUNBOOK section 5).")
    return 0


def _positive_seconds(raw: str) -> float:
    value = float(raw)
    if not 0 < value <= 60:
        raise argparse.ArgumentTypeError("the check exposure is between 0 and 60 seconds")
    return value


def main(arguments: list[str]) -> int:
    parser = argparse.ArgumentParser(prog=f"python -m darkview_agent {COMMAND}")
    parser.add_argument("--exposure-seconds", type=_positive_seconds, default=1.0)
    parser.add_argument("--gain", type=int, default=0)
    parser.add_argument("--solve", action="store_true", help="run ASTAP on the check frame")
    options = parser.parse_args(arguments)

    try:
        # The setup file can carry device paths but never DRIVER_MODE or ATTENDED.
        config = load_config(resolve_environment(dict(os.environ)))
    except ConfigurationError as error:
        print(f"FAIL configuration: {error}")
        return 2
    return run_check_devices(
        config,
        print,
        exposure_seconds=options.exposure_seconds,
        gain=options.gain,
        solve=options.solve,
    )
