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

Both pointing commands are judged on where the telescope would end up, not on
how far it would move. GOTO says where it is going. NUDGE does not: it is
relative to wherever the mount is now, so step 6 reads the current position and
checks the projected one. A step within every relative limit can still land
outside the envelope, because `nudgeMaxDegrees` is measured from the booked
target and MAX_ALT_SAFE is measured from the mount.
"""

from __future__ import annotations

import logging
import uuid
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from contracts.models import (
    CommandAcceptanceStatus,
    CommandEnvelope,
    CommandRejectionReason,
)
from darkview_agent.command.audit import AuditEvent, AuditLog
from darkview_agent.safety.coordinates import equatorial_to_horizontal
from darkview_agent.safety.envelope import SafetyEnvelope, normalise_azimuth

logger = logging.getLogger("darkview.agent.command")

# Commands that move the telescope somewhere the sky can be wrong about.
POINTING_COMMANDS = {"GOTO", "NUDGE"}

# Commands that must remain available whatever the envelope says.
RECOVERY_COMMANDS = {"PARK", "ABORT"}

ARCMINUTES_PER_DEGREE = 60.0


class SeenCommands(Protocol):
    """Which commands have already been decided.

    An interface because where it lives decides what a restart costs. In memory
    it is bounded and forgotten on reboot; in the local state store (DV-027) a
    command retried across a restart is still refused, which is the guarantee
    `docs/observatory-protocol.md` requires before hardware is enabled.
    """

    def has(self, command_id: str) -> bool: ...

    def remember(self, command_id: str, at: datetime) -> None: ...


class BoundedSeenCommands:
    """The default: the most recent decisions, in memory.

    Bounded, because an agent runs for months. When it overflows the oldest go,
    which means a very old command could in principle be accepted twice -- but
    the window is far longer than any `expiresAt`, so expiry catches that first.
    """

    def __init__(self, capacity: int = 4096) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._capacity = capacity
        self._seen: OrderedDict[str, datetime] = OrderedDict()

    def __len__(self) -> int:
        return len(self._seen)

    def has(self, command_id: str) -> bool:
        return command_id in self._seen

    def remember(self, command_id: str, at: datetime) -> None:
        self._seen[command_id] = at
        while len(self._seen) > self._capacity:
            self._seen.popitem(last=False)


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

    The seen-set is what makes retries safe. Where it is kept is injected: in
    memory by default, in the local state store when one is open, and that choice
    is the difference between a restart forgetting a slew it already performed
    and refusing it a second time.
    """

    def __init__(
        self,
        envelope: SafetyEnvelope | None = None,
        audit: AuditLog | None = None,
        seen: SeenCommands | None = None,
        attended: bool = False,
        pointing: Callable[[], tuple[float, float]] | None = None,
    ) -> None:
        self._envelope = envelope or SafetyEnvelope()
        # Where the mount is now, as (altitude, azimuth) in degrees. A callable
        # rather than a driver: this module decides, it does not drive, and a test
        # needs to place the telescope somewhere without a device.
        #
        # None means the position is unknowable, and an unknowable position
        # refuses every nudge. A GOTO names where it is going and can be judged on
        # its own; a nudge is relative to wherever the mount happens to be, so
        # without that there is nothing to judge.
        self._pointing = pointing
        # Whether an operator is physically at the observatory, from the local
        # configuration and nothing else. Defaults to False for the same reason
        # `load_config` refuses to start REAL without it: unattended is the state
        # to assume when nobody has said otherwise.
        self._attended = attended
        # Not `audit or AuditLog()`: AuditLog defines __len__, so an empty one is
        # falsy and an injected log would be silently discarded.
        self._audit = AuditLog() if audit is None else audit
        self._seen: SeenCommands = BoundedSeenCommands() if seen is None else seen
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

    def set_nudge_offset(self, degrees: float) -> None:
        """Restore an allowance already spent, after a restart.

        Only `StateStore` has a reason to call this. Everything else either
        spends the allowance a step at a time or returns it with
        `reset_nudge_offset`.
        """
        self._cumulative_nudge_degrees = max(0.0, degrees)

    def reset_nudge_offset(self) -> None:
        """Forget how far the customer has nudged from the booked target.

        Called after a recentring GOTO puts the mount back on target. The offset
        measures drift away from what was booked, so once the drift is undone the
        allowance is spent on nothing and must be returned — otherwise the
        recentre control takes the customer's remaining nudges away rather than
        giving them back, and a session ends unable to move at all.
        """
        self.set_nudge_offset(0.0)

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
        if self._seen.has(command_id):
            return self._duplicate(envelope)

        ack = self._evaluate(envelope, at_time)
        self._seen.remember(command_id, at_time)
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

    def operator_override(self, envelope: CommandEnvelope) -> bool:
        """Whether this command may lift the daylight lock.

        Public because the mission a GOTO starts has to be admitted under the
        same answer. Two copies of this rule would be two places for it to drift,
        and the copy that drifted open would be the one nobody noticed.

        The override exists for attended terrestrial testing, so the operator has
        to be here. `issuedByOperatorId` is a claim made by the cloud, and this
        validator exists to withhold exactly that trust: a compromised or simply
        buggy cloud must not be able to slew the mount in daylight with nobody at
        the observatory. The cloud's claim is a necessary condition, never a
        sufficient one; the local attended flag decides.
        """
        return self._attended and envelope.issued_by_operator_id is not None

    def _current_pointing(self) -> tuple[float, float] | None:
        """Where the mount is, or None if that cannot be established.

        A driver that raises is the same answer as no driver at all: unknown. It
        is not this function's job to decide what a broken mount means, only to
        refuse to guess where it is aimed.
        """
        if self._pointing is None:
            return None
        try:
            return self._pointing()
        except Exception:
            logger.warning("mount position unavailable; refusing the nudge")
            return None

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
                operator_override=self.operator_override(envelope),
            )
            if not verdict.permitted:
                assert verdict.reason is not None
                return self._reject(envelope, verdict.reason, verdict.detail)
            return None

        # NUDGE
        step_degrees = payload.step_arcminutes / ARCMINUTES_PER_DEGREE

        # The relative bound: how far this customer has moved from the target they
        # booked. It protects the framing, not the telescope.
        verdict = self._envelope.evaluate_nudge(self._cumulative_nudge_degrees, step_degrees)
        if not verdict.permitted:
            assert verdict.reason is not None
            return self._reject(envelope, verdict.reason, verdict.detail)

        # The absolute bound: where the mount would actually end up. Nothing above
        # this line knows that. `nudgeMaxDegrees` is measured from the locked
        # target, so a target parked just inside MAX_ALT_SAFE can be walked past it
        # by steps that are each within every relative limit.
        pointing = self._current_pointing()
        if pointing is None:
            return self._reject(
                envelope,
                CommandRejectionReason.device_unavailable,
                "the mount's current position could not be read, so where this "
                "nudge would land cannot be checked against the envelope",
            )

        altitude, azimuth = pointing
        signed_step = (
            step_degrees if payload.direction.value == "POSITIVE" else -step_degrees
        )
        if payload.axis.value == "ALTITUDE":
            altitude += signed_step
        else:
            azimuth = normalise_azimuth(azimuth + signed_step)

        verdict = self._envelope.evaluate_pointing(
            at_time,
            altitude,
            azimuth,
            operator_override=self.operator_override(envelope),
        )
        if not verdict.permitted:
            assert verdict.reason is not None
            return self._reject(envelope, verdict.reason, verdict.detail)

        # Only now. A refused nudge did not move the telescope, so it must not
        # consume any of the customer's allowance either.
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

    def has_seen(self, command_id: str) -> bool:
        return self._seen.has(command_id)
