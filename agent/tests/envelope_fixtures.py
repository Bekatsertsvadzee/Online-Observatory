"""Shared builders for envelope tests.

Every value is stated explicitly by the caller. There is deliberately no default
for `max_altitude_degrees` even here: a convenient test default is precisely how
an unmeasured value ends up looking measured.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from contracts.models import SafetyEnvelopeConfig
from darkview_agent.safety.sun import SiteLocation

TBILISI = SiteLocation(latitude_degrees=41.7151, longitude_degrees=44.8271)

# Deep night over Tbilisi: the Sun is far below the horizon, so daylight lock and
# Sun exclusion are satisfied and a test can isolate the rule it cares about.
NIGHT = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)

# Local solar noon over Tbilisi, Sun high in the south.
NOON = datetime(2026, 6, 21, 9, 0, tzinfo=UTC)


def build_config(
    *,
    max_altitude_degrees: float | None,
    min_altitude_degrees: float = 20.0,
    horizon_mask: list | None = None,
    forbidden_azimuth_sectors: list | None = None,
    sun_exclusion_degrees: float = 30.0,
    daylight_lock_sun_altitude_degrees: float = -12.0,
    nudge_max_degrees: float = 0.5,
    nudge_rate_degrees_per_second: float = 0.1,
    slew_timeout_seconds: int = 120,
    heartbeat_loss_seconds: int = 15,
    link_dead_seconds: int = 60,
) -> SafetyEnvelopeConfig:
    return SafetyEnvelopeConfig.model_validate(
        {
            "observatoryId": str(uuid4()),
            "minAltitudeDegrees": min_altitude_degrees,
            "maxAltitudeDegrees": max_altitude_degrees,
            "horizonMask": horizon_mask or [],
            "forbiddenAzimuthSectors": forbidden_azimuth_sectors or [],
            "sunExclusionDegrees": sun_exclusion_degrees,
            "daylightLockSunAltitudeDegrees": daylight_lock_sun_altitude_degrees,
            "nudgeMaxDegrees": nudge_max_degrees,
            "nudgeRateDegreesPerSecond": nudge_rate_degrees_per_second,
            "slewTimeoutSeconds": slew_timeout_seconds,
            "heartbeatLossSeconds": heartbeat_loss_seconds,
            "linkDeadSeconds": link_dead_seconds,
            "refocusTemperatureDeltaC": 1.5,
            "updatedAt": datetime.now(UTC).isoformat(),
        }
    )


def mask_entry(azimuth_degrees: float, min_altitude_degrees: float) -> dict:
    return {
        "azimuthDegrees": azimuth_degrees,
        "minAltitudeDegrees": min_altitude_degrees,
    }


def sector(from_degrees: float, to_degrees: float) -> dict:
    return {"fromDegrees": from_degrees, "toDegrees": to_degrees}
