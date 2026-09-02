"""Builders for command envelopes.

Every envelope a test uses is built here so that a test states only the thing it
is about. A test asserting expiry should not be carrying an optical
configuration around.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from darkview_agent.command.validator import SessionOwnership

MISSION_ID = uuid4()
SESSION_ID = uuid4()
USER_ID = uuid4()

OWNERSHIP = SessionOwnership(
    mission_id=MISSION_ID, session_id=SESSION_ID, user_id=USER_ID
)

NOW = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)


def envelope(
    *,
    command_type: str = "PARK",
    payload: dict | None = None,
    command_id: UUID | None = None,
    mission_id: UUID | None = None,
    session_id: UUID | None = None,
    user_id: UUID | None = None,
    issued_at: datetime | None = None,
    expires_at: datetime | None = None,
    issued_by_operator_id: UUID | None = None,
    override_reason: str | None = None,
) -> dict:
    issued = issued_at or NOW
    return {
        "commandId": str(command_id or uuid4()),
        "missionId": str(mission_id or MISSION_ID),
        "sessionId": str(session_id or SESSION_ID),
        "userId": str(user_id or USER_ID),
        "issuedAt": issued.isoformat(),
        "expiresAt": (expires_at or issued + timedelta(seconds=30)).isoformat(),
        "type": command_type,
        "payload": payload or {"kind": "PARK", "reason": "test"},
        "issuedByOperatorId": (
            str(issued_by_operator_id) if issued_by_operator_id else None
        ),
        "overrideReason": override_reason,
    }


def goto_payload(ra_hours: float = 18.0, dec_degrees: float = 40.0) -> dict:
    return {
        "kind": "GOTO",
        "targetId": str(uuid4()),
        "coordinates": {
            "raHours": ra_hours,
            "decDegrees": dec_degrees,
            "epoch": "J2000",
        },
        "opticalConfig": "F10_NATIVE",
        "imagingProfile": "GLOBULAR_CLUSTER",
        "recenter": False,
    }


def nudge_payload(step_arcminutes: float = 3.0, axis: str = "ALTITUDE") -> dict:
    return {
        "kind": "NUDGE",
        "axis": axis,
        "direction": "POSITIVE",
        "stepArcminutes": step_arcminutes,
    }


def capture_payload() -> dict:
    return {
        "kind": "CAPTURE",
        "imagingProfile": "GLOBULAR_CLUSTER",
        "requestedFrames": 30,
    }


def goto(**kwargs) -> dict:
    payload = kwargs.pop("payload", None) or goto_payload()
    return envelope(command_type="GOTO", payload=payload, **kwargs)


def nudge(**kwargs) -> dict:
    payload = kwargs.pop("payload", None) or nudge_payload()
    return envelope(command_type="NUDGE", payload=payload, **kwargs)


def park(**kwargs) -> dict:
    return envelope(command_type="PARK", payload={"kind": "PARK"}, **kwargs)


def abort(**kwargs) -> dict:
    return envelope(command_type="ABORT", payload={"kind": "ABORT"}, **kwargs)
