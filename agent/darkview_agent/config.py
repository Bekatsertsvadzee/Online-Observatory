"""Agent configuration.

Two rules govern this file:

1. The simulator is the default. Selecting real hardware takes an explicit,
   non-default setting AND the attended-mode flag. Neither alone is enough.
2. `max_altitude_degrees` has no default anywhere. `None` means UNMEASURED, and
   an unmeasured agent refuses every slew.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from enum import StrEnum

from darkview_agent.safety.sun import SiteLocation


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
    observatory_id: uuid.UUID | None = None
    site: SiteLocation | None = None

    @property
    def is_simulated(self) -> bool:
        return self.driver_mode is DriverMode.SIMULATED

    @property
    def can_dial_out(self) -> bool:
        """Whether there is enough configuration to open the link at all."""
        return bool(self.cloud_url and self.device_token and self.observatory_id)


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
        observatory_id=_observatory_id(env),
        site=_site(env),
    )


def _observatory_id(environment: dict[str, str]) -> uuid.UUID | None:
    raw = environment.get("DARKVIEW_AGENT_OBSERVATORY_ID", "").strip()
    if raw == "":
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise ConfigurationError(
            f"DARKVIEW_AGENT_OBSERVATORY_ID={raw!r} is not a UUID. It identifies this "
            "observatory to the cloud and must match the record the device token belongs to."
        ) from None


def _site(environment: dict[str, str]) -> SiteLocation | None:
    """Where the observatory physically is, or None if it has not been surveyed.

    Both coordinates or neither. Half a position is worse than none: the Sun
    check would run against a latitude paired with a default longitude and return
    a confident, wrong answer. `None` leaves the envelope siteless, which refuses
    every slew — the same fail-closed posture as an unmeasured MAX_ALT_SAFE.
    """
    raw_latitude = environment.get("DARKVIEW_AGENT_SITE_LATITUDE", "").strip()
    raw_longitude = environment.get("DARKVIEW_AGENT_SITE_LONGITUDE", "").strip()

    if raw_latitude == "" and raw_longitude == "":
        return None
    if raw_latitude == "" or raw_longitude == "":
        raise ConfigurationError(
            "DARKVIEW_AGENT_SITE_LATITUDE and DARKVIEW_AGENT_SITE_LONGITUDE must be set "
            "together. One without the other would pair a real coordinate with a "
            "default one and compute the Sun's position from a place that does not exist."
        )

    try:
        return SiteLocation(
            latitude_degrees=float(raw_latitude), longitude_degrees=float(raw_longitude)
        )
    except ValueError as error:
        raise ConfigurationError(f"site coordinates are not usable: {error}") from None
