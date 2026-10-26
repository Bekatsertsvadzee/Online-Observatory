"""Agent start-up.

Selects device implementations from configuration and reports what it selected.
Real drivers are unreachable without both an explicit setting and attended mode;
`load_config` refuses the unsafe combination before this code runs.
"""

from __future__ import annotations

import functools
import importlib.util
import logging
import math
from enum import StrEnum
from pathlib import Path
from typing import Any

from contracts.models import MissionFailureReason, OpticalConfig
from darkview_agent.config import AgentConfig, ConfigurationError, DriverMode
from darkview_agent.devices.alpaca import AlpacaMount
from darkview_agent.devices.alpaca_focuser import AlpacaFocuser
from darkview_agent.devices.base import CameraDriver, FocuserDriver, MountDriver
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.devices.zwo import ZwoCamera
from darkview_agent.devices.zwoasi_binding import ZwoasiCamera
from darkview_agent.mission.solver import PlateSolver, SimSolver
from darkview_agent.safety.envelope import SafetyEnvelope
from darkview_agent.solve.astap import DEFAULT_TIMEOUT_SECONDS, AstapSolver

logger = logging.getLogger("darkview.agent")


class DeviceKind(StrEnum):
    MOUNT = "MOUNT"
    CAMERA = "CAMERA"
    FOCUSER = "FOCUSER"


FAULT_REASONS = {
    DeviceKind.MOUNT: MissionFailureReason.mount_fault,
    DeviceKind.CAMERA: MissionFailureReason.camera_fault,
    DeviceKind.FOCUSER: MissionFailureReason.focuser_fault,
}


def faulted_device(error: BaseException) -> DeviceKind | None:
    """Which device raised this, if it came through `Devices`."""
    kind = getattr(error, "darkview_device", None)
    return kind if isinstance(kind, DeviceKind) else None


def fault_reason(error: BaseException) -> MissionFailureReason:
    """The failure reason for a device error. MOUNT_FAULT when nothing says otherwise.

    An untagged error is one raised somewhere other than a driver call, and the
    mount is the device whose fault has to be assumed: it is the one that moves.
    """
    kind = faulted_device(error)
    return FAULT_REASONS[kind] if kind else MissionFailureReason.mount_fault


class _Attributed:
    """A driver that stamps which device it is onto anything it raises.

    Wrapped here rather than raised with a device-specific exception in each
    driver, because the fact needed is which device was being driven, and that is
    known at the call rather than at the raise. A driver stays a driver: it has no
    idea it is wrapped, and a new one gets this for nothing.
    """

    __slots__ = ("_driver", "_kind")

    def __init__(self, driver: Any, kind: DeviceKind) -> None:
        object.__setattr__(self, "_driver", driver)
        object.__setattr__(self, "_kind", kind)

    @property
    def driver(self) -> Any:
        """The driver underneath. For tests and for anything checking its type."""
        return self._driver

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._driver, name)
        if not callable(value):
            return value

        @functools.wraps(value)
        def attributing(*args: Any, **kwargs: Any) -> Any:
            try:
                return value(*args, **kwargs)
            except BaseException as error:
                # Only the innermost driver call stamps it: an error crossing two
                # devices belongs to the one that actually raised it.
                if getattr(error, "darkview_device", None) is None:
                    error.darkview_device = self._kind
                raise

        return attributing

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(self._driver, name, value)


class Devices:
    def __init__(self, mount: MountDriver, camera: CameraDriver, focuser: FocuserDriver) -> None:
        self.mount: MountDriver = _Attributed(mount, DeviceKind.MOUNT)
        self.camera: CameraDriver = _Attributed(camera, DeviceKind.CAMERA)
        self.focuser: FocuserDriver = _Attributed(focuser, DeviceKind.FOCUSER)


#: Focal length of each optical train, as the contract's OpticalConfig states them.
FOCAL_LENGTH_MM = {
    OpticalConfig.f20_barlow: 4064.0,
    OpticalConfig.f10_native: 2032.0,
    OpticalConfig.f6_3_reducer: 1280.0,
}

#: The ASI585MC's short side: 2160 pixels of 2.9 um, from ZWO's published
#: specification. A plate-solve hint, not a safety value: ASTAP is told roughly
#: how tall the field is so it matches at the right scale. First light confirms it.
ASI585MC_SENSOR_HEIGHT_MM = 2160 * 0.0029

HARDWARE_EXTRA_HINT = (
    "Install it with `pip install \"darkview-agent[hardware]\"` (or `pip install -e "
    "\".[hardware]\"` from agent/) into the agent's virtual environment."
)


def field_height_degrees(optical_config: OpticalConfig) -> float:
    return math.degrees(ASI585MC_SENSOR_HEIGHT_MM / FOCAL_LENGTH_MM[optical_config])


def _required_file(path: Path | None, name: str, what: str) -> Path:
    if path is None:
        raise ConfigurationError(f"REAL mode needs {name}: {what}.")
    if not path.is_file():
        raise ConfigurationError(f"{name}={path} does not exist or is not a file ({what}).")
    return path


def zwo_camera(config: AgentConfig) -> ZwoCamera:
    """The ASI585MC through zwoasi, refused clearly when either is missing."""
    sdk = _required_file(
        config.zwo_sdk_path,
        "DARKVIEW_AGENT_ZWO_SDK_PATH",
        "the ZWO ASI SDK library, e.g. C:\\...\\ASICamera2.dll",
    )
    # Looked up, not imported: the binding loads the SDK only when a camera opens.
    if importlib.util.find_spec("zwoasi") is None:
        raise ConfigurationError(f"The zwoasi binding is not installed. {HARDWARE_EXTRA_HINT}")
    return ZwoCamera(ZwoasiCamera(str(sdk), index=config.zwo_camera_index))


def astap_solver(
    config: AgentConfig, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
) -> AstapSolver:
    executable = _required_file(
        config.astap_path, "DARKVIEW_AGENT_ASTAP_PATH", "the ASTAP command-line executable"
    )
    database = config.astap_database_dir
    if database is not None and not database.is_dir():
        raise ConfigurationError(
            f"DARKVIEW_AGENT_ASTAP_DATABASE_DIR={database} is not a folder."
        )
    return AstapSolver(
        executable,
        field_height_degrees(config.optical_config),
        timeout_seconds=timeout_seconds,
        database_dir=database,
    )


def build_devices(config: AgentConfig) -> Devices:
    """Return the device set the configuration selects.

    REAL is the mount and focuser over the loopback Alpaca bridge and the camera
    through the ZWO SDK. `load_config` has already refused REAL without the
    attended flag. Anything REAL needs and does not have raises here; there is no
    fallback to the simulator, because an operator in attended mode must never be
    shown simulated output as if it were hardware.
    """
    if config.driver_mode is DriverMode.SIMULATED:
        return Devices(mount=SimMount(), camera=SimCamera(), focuser=SimFocuser())

    if not config.attended:
        raise ConfigurationError("REAL devices are only ever built for an attended operator.")
    return Devices(
        mount=AlpacaMount(config.alpaca_host, config.alpaca_port, config.mount_device_number),
        camera=zwo_camera(config),
        focuser=AlpacaFocuser(
            config.alpaca_host, config.alpaca_port, config.focuser_device_number
        ),
    )


def build_solver(config: AgentConfig) -> PlateSolver:
    """ASTAP for real frames; the simulator's solver only for the simulator's."""
    if config.driver_mode is DriverMode.SIMULATED:
        return SimSolver()
    return astap_solver(config)


def start(config: AgentConfig, envelope: SafetyEnvelope | None = None) -> Devices:
    """Start the agent and log the safety posture it is starting in."""
    envelope = envelope or SafetyEnvelope()
    devices = build_devices(config)

    logger.info("agent starting: driver_mode=%s attended=%s", config.driver_mode, config.attended)
    if envelope.is_measured:
        logger.info("safety envelope: MEASURED")
    else:
        logger.warning(
            "safety envelope: UNMEASURED — every slew will be refused with "
            "SAFETY_ENVELOPE_UNMEASURED until MAX_ALT_SAFE is measured"
        )
    return devices
