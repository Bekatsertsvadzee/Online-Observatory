"""What the agent tells the cloud about its devices, as AGENT_STATE_DELTA (#148).

The cloud had a handler for this message and the agent had no sender (ADR-024,
correction of 2026-09-22). It is sent now so the mission channel can show where
the mount is pointing: the customer watches the marker travel during SLEWING and
settle during CENTERING.

**Read-only.** This module reads device status and writes nothing to a device.
It adds no command, no inbound message and no path from a client to the mount.

**Throttled.** At most one sample every `SAMPLE_INTERVAL_SECONDS` -- two a second
-- and that is also the most often the devices are read for it. A sample is sent
while the mount is slewing, when anything a subscriber sees has changed, and
otherwise once every `REFRESH_INTERVAL_SECONDS`, so a customer who opens the room
while the mount is standing still still learns where it is.

**Never queued.** Like a live frame, a sample is worth nothing once the next one
exists, and replaying a backlog after an outage would show the mount where it
was rather than where it is.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from datetime import datetime

from pydantic import ValidationError

from contracts.models import (
    AgentStateDelta,
    DeviceHealth,
    MissionState,
    WeatherState,
)
from darkview_agent.clock import wire_timestamp
from darkview_agent.devices.base import CameraStatus, FocuserStatus, MountStatus
from darkview_agent.runtime import Devices
from darkview_agent.safety.envelope import normalise_azimuth

logger = logging.getLogger("darkview.agent.telemetry")

#: Two samples a second, at most, while the mount moves.
SAMPLE_INTERVAL_SECONDS = 0.5

#: A standing mount is restated this often, so a new subscriber is not left blank.
REFRESH_INTERVAL_SECONDS = 5.0

#: The precision a customer sees (the contract rounds `pointing` to 0.1°). A change
#: finer than this is not news, so a tracking mount does not send at full rate.
CHANGE_RESOLUTION_DEGREES = 0.1


def _read[T: (MountStatus, CameraStatus, FocuserStatus)](
    status: Callable[[], T],
) -> T | None:
    try:
        return status()
    except Exception as error:  # a status read must never take down the loop
        logger.warning("device status unreadable for telemetry: %s", error)
        return None


def _health(status: MountStatus | CameraStatus | FocuserStatus | None) -> dict:
    health = DeviceHealth.fault if status is None else status.health
    return {"health": health.value, "detail": None}


class TelemetryReporter:
    """Decides when a sample is due and builds it. Holds no device, sends nothing."""

    def __init__(
        self,
        devices: Devices,
        agent_version: str,
        started_at: datetime,
    ) -> None:
        self._devices = devices
        self._agent_version = agent_version
        self._started_at = started_at
        self._last_sampled_at: datetime | None = None
        self._last_sent_at: datetime | None = None
        self._last_key: tuple | None = None

    def reset(self) -> None:
        """Forget what was sent. The next connection gets a sample at once."""
        self._last_sampled_at = None
        self._last_sent_at = None
        self._last_key = None

    def sample(
        self,
        at_time: datetime,
        *,
        mission_id: str | None,
        mission_state: MissionState | None,
        centering_iteration: int | None,
        weather: WeatherState | None,
    ) -> dict | None:
        """The AGENT_STATE_DELTA due now, or None. Reads the devices only when due."""
        if not _elapsed(self._last_sampled_at, at_time, SAMPLE_INTERVAL_SECONDS):
            return None
        self._last_sampled_at = at_time

        mount = _read(self._devices.mount.status)
        camera = _read(self._devices.camera.status)
        focuser = _read(self._devices.focuser.status)

        pointing = None
        if mount is not None and -90.0 <= mount.altitude_degrees <= 90.0:
            pointing = {
                "altitudeDegrees": mount.altitude_degrees,
                "azimuthDegrees": normalise_azimuth(mount.azimuth_degrees),
            }
        slewing = mount.slewing if mount is not None else None

        telemetry = {
            "mode": self._devices.mount.mode.value,
            "link": "ONLINE",
            "mount": _health(mount),
            "camera": _health(camera),
            "focuser": _health(focuser),
            "weather": self._weather(weather),
            "pointingEquatorial": None,
            "pointingHorizontal": pointing,
            "tracking": mount.tracking if mount is not None else None,
            "parked": mount.parked if mount is not None else None,
            "slewing": slewing,
            "focuserPosition": focuser.position if focuser is not None else None,
            "ambientTemperatureC": None,
            "agentVersion": self._agent_version,
            "reportedAt": wire_timestamp(at_time),
        }
        delta = {
            "type": "AGENT_STATE_DELTA",
            "messageId": str(uuid.uuid4()),
            "sentAt": wire_timestamp(at_time),
            "telemetry": telemetry,
            "missionId": mission_id,
            "missionState": mission_state.value if mission_state else None,
            "failureReason": None,
            "centeringIteration": centering_iteration,
            "residualArcminutes": None,
        }

        key = _change_key(delta)
        if not (
            slewing
            or key != self._last_key
            or _elapsed(self._last_sent_at, at_time, REFRESH_INTERVAL_SECONDS)
        ):
            return None

        try:
            AgentStateDelta.model_validate(delta)
        except ValidationError as error:
            logger.error("telemetry sample does not satisfy the contract: %s", error)
            return None
        return delta

    def sent(self, delta: dict, at_time: datetime) -> None:
        self._last_sent_at = at_time
        self._last_key = _change_key(delta)

    def _weather(self, weather: WeatherState | None) -> dict:
        if weather is not None:
            return weather.model_dump(mode="json", by_alias=True)
        # Nobody has described the sky to this agent. Stated as UNKNOWN since the
        # agent started, never as CLEAR.
        return {
            "status": "UNKNOWN",
            "source": "OPERATOR",
            "holdActive": False,
            "note": "No weather has reached this agent yet.",
            "updatedAt": wire_timestamp(self._started_at),
        }


def _elapsed(since: datetime | None, at_time: datetime, seconds: float) -> bool:
    if since is None:
        return True
    elapsed = (at_time - since).total_seconds()
    # A wall clock stepped backwards is not a reason to go silent.
    return elapsed < 0 or elapsed >= seconds


def _change_key(delta: dict) -> tuple:
    telemetry = delta["telemetry"]
    pointing = telemetry["pointingHorizontal"]
    rounded = (
        None
        if pointing is None
        else (
            round(pointing["altitudeDegrees"] / CHANGE_RESOLUTION_DEGREES),
            round(pointing["azimuthDegrees"] / CHANGE_RESOLUTION_DEGREES),
        )
    )
    return (
        rounded,
        telemetry["mode"],
        telemetry["mount"]["health"],
        telemetry["camera"]["health"],
        telemetry["focuser"]["health"],
        telemetry["weather"]["status"],
        telemetry["weather"]["holdActive"],
        telemetry["tracking"],
        telemetry["parked"],
        telemetry["slewing"],
        telemetry["focuserPosition"],
        delta["missionId"],
        delta["missionState"],
        delta["centeringIteration"],
    )


__all__ = [
    "CHANGE_RESOLUTION_DEGREES",
    "REFRESH_INTERVAL_SECONDS",
    "SAMPLE_INTERVAL_SECONDS",
    "TelemetryReporter",
]
