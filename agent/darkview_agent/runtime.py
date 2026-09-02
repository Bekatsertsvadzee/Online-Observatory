"""Agent start-up.

Selects device implementations from configuration and reports what it selected.
Real drivers are unreachable without both an explicit setting and attended mode;
`load_config` refuses the unsafe combination before this code runs.
"""

from __future__ import annotations

import logging

from darkview_agent.config import AgentConfig, ConfigurationError, DriverMode
from darkview_agent.devices.base import CameraDriver, FocuserDriver, MountDriver
from darkview_agent.devices.simulated import SimCamera, SimFocuser, SimMount
from darkview_agent.safety.envelope import SafetyEnvelope

logger = logging.getLogger("darkview.agent")


class Devices:
    def __init__(self, mount: MountDriver, camera: CameraDriver, focuser: FocuserDriver) -> None:
        self.mount = mount
        self.camera = camera
        self.focuser = focuser


def build_devices(config: AgentConfig) -> Devices:
    """Return the device set the configuration selects.

    DV-028/029/031 add the real implementations. Until they exist, REAL mode
    raises rather than silently falling back to the simulator — a silent
    fallback would let an operator believe hardware is under test when it is not.
    """
    if config.driver_mode is DriverMode.SIMULATED:
        return Devices(mount=SimMount(), camera=SimCamera(), focuser=SimFocuser())

    raise ConfigurationError(
        "Real device drivers are not implemented yet (DV-028 mount, DV-029 camera, "
        "DV-031 focuser). Refusing to fall back to the simulator, because an operator "
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
