"""Agent configuration.

Two rules govern this file:

1. The simulator is the default. Selecting real hardware takes an explicit,
   non-default setting AND the attended-mode flag. Neither alone is enough.
2. `max_altitude_degrees` has no default anywhere. `None` means UNMEASURED, and
   an unmeasured agent refuses every slew.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import StrEnum


class DriverMode(StrEnum):
    SIMULATED = "SIMULATED"
    REAL = "REAL"


class ConfigurationError(Exception):
    """Raised when configuration would put the agent in an unsafe state."""


def _env_flag(environment: dict[str, str], name: str) -> bool:
    return environment.get(name, "").strip().lower() in {"1", "true", "yes"}


@dataclass(frozen=True)
class AgentConfig:
    """Resolved agent configuration.

    `driver_mode` defaults to SIMULATED. There is no code path that reaches
    DriverMode.REAL without both an explicit setting and the attended flag.
    """

    driver_mode: DriverMode = DriverMode.SIMULATED
    attended: bool = False
    cloud_url: str | None = None
    device_token: str | None = None

    @property
    def is_simulated(self) -> bool:
        return self.driver_mode is DriverMode.SIMULATED


def load_config(environment: dict[str, str] | None = None) -> AgentConfig:
    """Build configuration from the environment, refusing unsafe combinations.

    Raises ConfigurationError when real drivers are selected without an attended
    operator present. The agent does not start in that state.
    """
    env = dict(os.environ) if environment is None else environment

    raw_mode = env.get("DARKVIEW_AGENT_DRIVER_MODE", "").strip().upper()
    if raw_mode == "":
        driver_mode = DriverMode.SIMULATED
    elif raw_mode in tuple(DriverMode):
        driver_mode = DriverMode(raw_mode)
    else:
        raise ConfigurationError(
            f"DARKVIEW_AGENT_DRIVER_MODE={raw_mode!r} is not a driver mode. "
            f"Valid values: {', '.join(tuple(DriverMode))}."
        )

    attended = _env_flag(env, "DARKVIEW_AGENT_ATTENDED")

    if driver_mode is DriverMode.REAL and not attended:
        raise ConfigurationError(
            "Refusing to start: DARKVIEW_AGENT_DRIVER_MODE=REAL selects real hardware, "
            "but DARKVIEW_AGENT_ATTENDED is not set. Real-hardware mode requires an "
            "operator physically present at the observatory. No background or automated "
            "session may command the mount or camera."
        )

    return AgentConfig(
        driver_mode=driver_mode,
        attended=attended,
        cloud_url=env.get("DARKVIEW_AGENT_CLOUD_URL") or None,
        device_token=env.get("DARKVIEW_AGENT_DEVICE_TOKEN") or None,
    )
