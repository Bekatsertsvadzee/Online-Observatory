from datetime import UTC, datetime
from uuid import uuid4

import pytest

from contracts.models import ErrorCode, SafetyEnvelopeConfig
from darkview_agent.safety.envelope import SafetyEnvelope, SafetyRefusal


def envelope_config(max_altitude_degrees: float | None) -> SafetyEnvelopeConfig:
    """Build a config with an explicit MAX_ALT_SAFE.

    Every caller states the value. There is deliberately no helper default —
    a test fixture default is exactly how an unmeasured value ships.
    """
    return SafetyEnvelopeConfig.model_validate(
        {
            "observatoryId": str(uuid4()),
            "minAltitudeDegrees": 20.0,
            "maxAltitudeDegrees": max_altitude_degrees,
            "horizonMask": [],
            "forbiddenAzimuthSectors": [],
            "sunExclusionDegrees": 30.0,
            "daylightLockSunAltitudeDegrees": -12.0,
            "nudgeMaxDegrees": 0.5,
            "nudgeRateDegreesPerSecond": 0.25,
            "slewTimeoutSeconds": 120,
            "heartbeatLossSeconds": 15,
            "linkDeadSeconds": 60,
            "refocusTemperatureDeltaC": 1.5,
            "updatedAt": datetime.now(UTC).isoformat(),
        }
    )


def test_no_config_at_all_is_unmeasured():
    assert SafetyEnvelope().is_measured is False


def test_null_max_altitude_loads_successfully_and_is_unmeasured():
    """Acceptance criterion 4: null loads, and puts the agent in UNMEASURED."""
    envelope = SafetyEnvelope(config=envelope_config(None))
    assert envelope.config is not None
    assert envelope.config.max_altitude_degrees is None
    assert envelope.is_measured is False


def test_unmeasured_envelope_refuses_every_slew():
    """Acceptance criterion 4: the refusal carries the contract's error code."""
    envelope = SafetyEnvelope(config=envelope_config(None))

    with pytest.raises(SafetyRefusal) as raised:
        envelope.assert_may_slew()

    assert raised.value.code is ErrorCode.safety_not_configured
    assert "UNMEASURED" in raised.value.reason


def test_measured_envelope_permits_the_slew_gate():
    """A measured value passes this gate. DV-023 adds the coordinate checks after it."""
    envelope = SafetyEnvelope(config=envelope_config(68.0))
    assert envelope.is_measured is True
    envelope.assert_may_slew()


def test_contract_model_is_imported_not_redefined():
    """Acceptance criterion 6: the shared type comes from the generated models."""
    assert SafetyEnvelopeConfig.__module__ == "contracts.models"
