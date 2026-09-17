"""Agent start-up.

Selects device implementations from configuration and reports what it selected.
Real drivers are unreachable without both an explicit setting and attended mode;
`load_config` refuses the unsafe combination before this code runs.
"""

from __future__ import annotations

import functools
import logging
from enum import StrEnum
from typing import Any

from contracts.models import MissionFailureReason
from darkview_agent.config import AgentConfig, ConfigurationError, DriverMode
from darkview_agent.devices.base import CameraDriver, FocuserDriver, MountDriver
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.safety.envelope import SafetyEnvelope

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


def build_devices(config: AgentConfig) -> Devices:
    """Return the device set the configuration selects.

    DV-028 added `AlpacaMount` and DV-029 `ZwoCamera`; the real focuser driver is
    still missing, and real devices beside a simulated one are not a real observatory.
    Until they exist, REAL mode raises rather than silently falling back to the
    simulator — a silent fallback would let an operator believe hardware is under
    test when it is not.
    """
    if config.driver_mode is DriverMode.SIMULATED:
        return Devices(mount=SimMount(), camera=SimCamera(), focuser=SimFocuser())

    raise ConfigurationError(
        "Real device drivers are not all implemented yet (the focuser has no real "
        "driver). Refusing to fall back to the simulator, because an operator "
        "in attended mode must never be shown simulated output as if it were hardware."
    )


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
