"""Command envelope validation.

Every command the cloud sends is checked again here, from scratch. The cloud
already validated it; that is not a reason to trust it. A REJECTED ack carrying
a SAFETY_ reason after the cloud approved the command is the design working, not
a bug — it is the second of the two independent checks doing its job.

Checks run in a deliberate order, cheapest and most fundamental first:

    1. structure        a payload that will not parse cannot be reasoned about
    2. idempotency      a repeat must never touch the device twice
    3. expiry           a command queued before a reconnect must not fire after it
    4. authorisation    session, then user, then mission
    5. payload kind     the envelope's type and its payload must agree
    6. safety envelope  the last word, and the only one that inspects the sky

PARK and ABORT skip step 6. Park is the answer to every unresolved condition and
moves the mount to a known-safe position by definition; refusing it because the
envelope is unmeasured would strand a telescope in exactly the situation Park
exists to resolve. They are still fully authorised — an unauthorised Park is
still unauthorised.
"""

from __future__ import annotations

import logging
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime

from contracts.models import (
    CommandAcceptanceStatus,
    CommandEnvelope,
    CommandRejectionReason,
)
from darkview_agent.command.audit import AuditEvent, AuditLog
from darkview_agent.safety.coordinates import equatorial_to_horizontal
from darkview_agent.safety.envelope import SafetyEnvelope

logger = logging.getLogger("darkview.agent.command")

# Commands that move the telescope somewhere the sky can be wrong about.
POINTING_COMMANDS = {"GOTO", "NUDGE"}

# Commands that must remain available whatever the envelope says.
RECOVERY_COMMANDS = {"PARK", "ABORT"}

ARCMINUTES_PER_DEGREE = 60.0


@dataclass(frozen=True)
class SessionOwnership:
    """Who currently owns the observatory. One session at a time, always."""

    mission_id: uuid.UUID
    session_id: uuid.UUID
    user_id: uuid.UUID


@dataclass(frozen=True)
class Ack:
    """The agent's verdict on one command, ready to become an AgentCommandAck."""

    command_id: str
    status: CommandAcceptanceStatus
    mission_id: str | None = None
    rejection_reason: CommandRejectionReason | None = None
    detail: str = ""

    @property
    def accepted(self) -> bool:
        return self.status is CommandAcceptanceStatus.accepted

    def to_message(self) -> dict:
        """The wire form the link sends."""
        return {
            "type": "AGENT_COMMAND_ACK",
            "messageId": str(uuid.uuid4()),
            "sentAt": datetime.now(tz=None).astimezone().isoformat(),
            "commandId": self.command_id,
            "missionId": self.mission_id,
            "status": self.status.value,
            "rejectionReason": (
                self.rejection_reason.value if self.rejection_reason else None
            ),
            "detail": self.detail or None,
        }


class CommandValidator:
    """Validates commands and remembers what it has already decided.

    The seen-set is what makes retries safe. It is bounded, because an agent runs
    for months; when it overflows the oldest entries go, which means a very old
    command could in principle be accepted twice. The window is far longer than
    any `expiresAt`, so expiry catches that case first.
    """

    def __init__(
        self,
        envelope: SafetyEnvelope | None = None,
        audit: AuditLog | None = None,
        seen_capacity: int = 4096,
        attended: bool = False,
    ) -> None:
        self._envelope = envelope or SafetyEnvelope()
        # Whether an operator is physically at the observatory, from the local
        # configuration and nothing else. Defaults to False for the same reason
        # `load_config` refuses to start REAL without it: unattended is the state
        # to assume when nobody has said otherwise.
        self._attended = attended
        # Not `audit or AuditLog()`: AuditLog defines __len__, so an empty one is
        # falsy and an injected log would be silently discarded.
        self._audit = AuditLog() if audit is None else audit
        self._seen: OrderedDict[str, Ack] = OrderedDict()
        self._seen_capacity = seen_capacity
        self._ownership: SessionOwnership | None = None
        self._cumulative_nudge_degrees = 0.0

    # ------------------------------------------------------------------
    # State the agent holds
    # ------------------------------------------------------------------

    @property
    def audit(self) -> AuditLog:
        return self._audit

    @property
    def ownership(self) -> SessionOwnership | None:
        return self._ownership

    @property
    def cumulative_nudge_degrees(self) -> float:
        return self._cumulative_nudge_degrees

    def set_ownership(self, ownership: SessionOwnership | None) -> None:
        """Hand the observatory to a session, or to nobody.

        Changing owner resets the accumulated nudge offset: the limit protects a
        booked target from drifting away under one customer's nudges, and the
        next session starts from its own target.
        """
        self._ownership = ownership
        self._cumulative_nudge_degrees = 0.0

    def set_envelope(self, envelope: SafetyEnvelope) -> None:
        self._envelope = envelope

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def validate(self, raw_envelope: dict, at_time: datetime) -> Ack:
        """Decide one command. Always returns exactly one ack."""
        command_id = str(raw_envelope.get("commandId", "")) or "unknown"

        # 1. Structure.
        try:
            envelope = CommandEnvelope.model_validate(raw_envelope)
        except Exception as error:
            return self._reject_unparsed(command_id, error)

        command_id = str(envelope.command_id)

        # 2. Idempotency. Before anything else with a side effect.
        if command_id in self._seen:
            return self._duplicate(envelope)

        ack = self._evaluate(envelope, at_time)
        self._remember(command_id, ack)
        return ack

    def _evaluate(self, envelope: CommandEnvelope, at_time: datetime) -> Ack:
        command_type = envelope.type.value

        # 3. Expiry. A command queued before a reconnect must not fire after it.
        if envelope.expires_at <= at_time:
            return self._reject(
                envelope,
                CommandRejectionReason.command_expired,
                f"expired at {envelope.expires_at.isoformat()}, now {at_time.isoformat()}",
                status=CommandAcceptanceStatus.expired,
            )

        # 4. Authorisation.
        if self._ownership is None:
            return self._reject(
                envelope,
                CommandRejectionReason.no_active_mission,
                "the agent holds no mission, so no command is authorised",
            )
        if envelope.session_id != self._ownership.session_id:
            return self._reject(
                envelope,
                CommandRejectionReason.wrong_session,
                "sessionId is not the current session owner",
            )
        if envelope.user_id != self._ownership.user_id:
            return self._reject(
                envelope,
                CommandRejectionReason.wrong_user,
                "userId does not match the session owner",
            )
        if envelope.mission_id != self._ownership.mission_id:
            return self._reject(
                envelope,
                CommandRejectionReason.wrong_mission,
                "missionId is not the mission the agent currently holds",
            )

        # 5. The envelope's type and its payload must agree.
        payload = envelope.payload.root
        if payload.kind != command_type:
            return self._reject(
                envelope,
                CommandRejectionReason.payload_type_mismatch,
                f"envelope type is {command_type} but payload kind is {payload.kind}",
            )

        # 6. Safety. Recovery commands are exempt from the pointing check.
        if command_type in RECOVERY_COMMANDS:
            return self._accept(envelope)
        if command_type in POINTING_COMMANDS:
            refusal = self._check_pointing(envelope, payload, at_time)
            if refusal is not None:
                return refusal

        return self._accept(envelope)

    def _operator_override(self, envelope: CommandEnvelope) -> bool:
        """Whether this command may lift the daylight lock.

        The override exists for attended terrestrial testing, so the operator has
        to be here. `issuedByOperatorId` is a claim made by the cloud, and this
        validator exists to withhold exactly that trust: a compromised or simply
        buggy cloud must not be able to slew the mount in daylight with nobody at
        the observatory. The cloud's claim is a necessary condition, never a
        sufficient one; the local attended flag decides.
        """
        return self._attended and envelope.issued_by_operator_id is not None

    def _check_pointing(self, envelope: CommandEnvelope, payload, at_time: datetime) -> Ack | None:
        if payload.kind == "GOTO":
            if self._envelope.site is None:
                return self._reject(
                    envelope,
                    CommandRejectionReason.safety_sun_exclusion,
                    "observatory coordinates are not configured, so the target's "
                    "altitude and its separation from the Sun cannot be computed",
                )
            horizontal = equatorial_to_horizontal(
                payload.coordinates.ra_hours,
                payload.coordinates.dec_degrees,
                at_time,
                self._envelope.site,
            )
            verdict = self._envelope.evaluate_pointing(
                at_time,
                horizontal.altitude_degrees,
                horizontal.azimuth_degrees,
                operator_override=self._operator_override(envelope),
            )
            if not verdict.permitted:
                assert verdict.reason is not None
                return self._reject(envelope, verdict.reason, verdict.detail)
            return None

        # NUDGE
        step_degrees = payload.step_arcminutes / ARCMINUTES_PER_DEGREE
        verdict = self._envelope.evaluate_nudge(self._cumulative_nudge_degrees, step_degrees)
        if not verdict.permitted:
            assert verdict.reason is not None
            return self._reject(envelope, verdict.reason, verdict.detail)
        self._cumulative_nudge_degrees += step_degrees
        return None

    # ------------------------------------------------------------------
    # Outcomes
    # ------------------------------------------------------------------

    def _accept(self, envelope: CommandEnvelope) -> Ack:
        self._audit.record(
            AuditEvent(
                occurred_at=envelope.issued_at,
                kind="COMMAND_ACCEPTED",
                command_id=str(envelope.command_id),
                detail=envelope.type.value,
                context={"missionId": str(envelope.mission_id)},
            )
        )
        return Ack(
            command_id=str(envelope.command_id),
            mission_id=str(envelope.mission_id),
            status=CommandAcceptanceStatus.accepted,
        )

    def _reject(
        self,
        envelope: CommandEnvelope,
        reason: CommandRejectionReason,
        detail: str,
        status: CommandAcceptanceStatus = CommandAcceptanceStatus.rejected,
    ) -> Ack:
        """Criterion 7: every rejection writes a local audit event."""
        self._audit.record(
            AuditEvent(
                occurred_at=envelope.issued_at,
                kind="COMMAND_REJECTED",
                command_id=str(envelope.command_id),
                reason=reason.value,
                detail=detail,
                context={
                    "missionId": str(envelope.mission_id),
                    "type": envelope.type.value,
                },
            )
        )
        logger.warning(
            "command %s refused: %s (%s)", envelope.command_id, reason.value, detail
        )
        return Ack(
            command_id=str(envelope.command_id),
            mission_id=str(envelope.mission_id),
            status=status,
            rejection_reason=reason,
            detail=detail,
        )

    def _reject_unparsed(self, command_id: str, error: Exception) -> Ack:
        """A malformed envelope. Not remembered: there is no trustworthy id to
        remember it by, and refusing it again costs nothing."""
        self._audit.record(
            AuditEvent(
                occurred_at=datetime.now(tz=None).astimezone(),
                kind="COMMAND_REJECTED",
                command_id=command_id,
                reason=CommandRejectionReason.malformed_payload.value,
                detail=str(error)[:400],
            )
        )
        logger.warning("command %s refused: malformed envelope", command_id)
        return Ack(
            command_id=command_id,
            status=CommandAcceptanceStatus.rejected,
            rejection_reason=CommandRejectionReason.malformed_payload,
            detail="the command envelope did not match the contract",
        )

    def _duplicate(self, envelope: CommandEnvelope) -> Ack:
        """A repeat. The device is not touched again.

        A duplicate is still acked. Retries exist because acks get lost, so an
        unanswered repeat would leave the cloud waiting forever for a verdict it
        already had.
        """
        command_id = str(envelope.command_id)
        self._audit.record(
            AuditEvent(
                occurred_at=envelope.issued_at,
                kind="COMMAND_DUPLICATE",
                command_id=command_id,
                reason=CommandRejectionReason.duplicate_command_id.value,
                detail="already decided; the device was not touched again",
            )
        )
        return Ack(
            command_id=command_id,
            mission_id=str(envelope.mission_id),
            status=CommandAcceptanceStatus.duplicate,
            rejection_reason=CommandRejectionReason.duplicate_command_id,
            detail="this commandId has already been decided",
        )

    def _remember(self, command_id: str, ack: Ack) -> None:
        self._seen[command_id] = ack
        while len(self._seen) > self._seen_capacity:
            self._seen.popitem(last=False)

    def has_seen(self, command_id: str) -> bool:
        return command_id in self._seen
