"""The agent's run loop: where a cloud command becomes mount movement.

Every part of this file already existed separately. The link knew how to stay
connected, the validator knew how to refuse a command, the runner knew how to
fly a mission and the watchdog knew how to park. Nothing joined them, so a
command minted by the cloud reached the agent's socket and was dropped. This is
the join.

Four rules shape it.

**The validator is wired, not defaulted.** `pointing` is the mount's own status
and `attended` is the local configuration flag. Both default to the safe answer
in `CommandValidator`, which means an unwired agent refuses every nudge and can
never lift the daylight lock — correct, and silent. Wiring them here is what
issues #10 and #12 were left owing.

**Validation and execution are separate questions.** The validator answers "is
this command authorised and safe?". This file answers "can the observatory
actually do it right now?" — is a different mission running, is the mount
already slewing, does this build have the pipeline the command needs. A command
that passes the first and fails the second is refused with a rejection reason
that says so, and the device is not touched.

**One thread touches the devices.** The watchdog runs on its own and parks
without asking anyone. Every device call here is taken under the lock the
watchdog exposes for exactly this purpose, so a Park never interleaves with a
slew.

**Polled, with injected time.** Like the link, the runner and the watchdog:
`pump()` does whatever is due. There is no sleeping, no blocking and no
background work in this file, which is what makes an entire mission testable at
a chosen instant.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from contracts.models import (
    CommandAcceptanceStatus,
    CommandEnvelope,
    CommandRejectionReason,
    MissionFailureReason,
    SafetyEnvelopeConfig,
)
from darkview_agent.clock import Clock, SystemClock
from darkview_agent.command.audit import AuditEvent, AuditLog
from darkview_agent.command.validator import Ack, CommandValidator, SessionOwnership
from darkview_agent.config import AgentConfig
from darkview_agent.devices.base import DeviceError
from darkview_agent.link.session import LinkSession
from darkview_agent.mission.runner import (
    MissionAlreadyActive,
    MissionEvent,
    MissionRequest,
    MissionRunner,
)
from darkview_agent.mission.solver import PlateSolver, SimSolver
from darkview_agent.runtime import Devices
from darkview_agent.safety.coordinates import equatorial_to_horizontal
from darkview_agent.safety.envelope import SafetyEnvelope, normalise_azimuth
from darkview_agent.safety.watchdog import Watchdog
from darkview_agent.state.store import StateStore, StoredMission, StoredOwnership

logger = logging.getLogger("darkview.agent.supervisor")

ARCMINUTES_PER_DEGREE = 60.0

# How often the main loop runs. Well under the shortest heartbeat interval, so a
# heartbeat is never late because the loop was between passes.
DEFAULT_LOOP_INTERVAL_SECONDS = 0.25

#: Command types the contract defines that this build cannot carry out, and the
#: issue that will make each of them work. Refused rather than silently accepted:
#: an ACCEPTED ack for a command nothing performs tells the cloud, the operator
#: and the customer that the telescope did something it did not do.
UNIMPLEMENTED_COMMANDS: dict[str, str] = {
    "CAPTURE": (
        "CAPTURE needs the live-stack and upload pipeline (DV-033) and the media "
        "store (DV-061). This agent build has neither, so nothing would be kept"
    ),
    "FOCUS": "FOCUS needs the focuser driver and autofocus routine (DV-031)",
    "SET_PROFILE": (
        "SET_PROFILE needs the imaging profile table that maps a profile to "
        "exposure, gain and ROI (DV-033)"
    ),
}

#: A refusal this file produces: why, and the sentence the ack carries.
Refusal = tuple[CommandRejectionReason, str]


@dataclass(frozen=True)
class _Owner:
    """The session the cloud says owns the observatory, and when it lapses."""

    ownership: SessionOwnership
    expires_at: datetime | None


class Supervisor:
    """Owns the link, the validator, the runner and the watchdog, and pumps them.

    Constructed with its parts rather than building them, so a test can drive a
    whole mission through a fake transport against the simulator with no sockets,
    no threads and no real clock. `build_supervisor` does the wiring for the
    process.
    """

    def __init__(
        self,
        config: AgentConfig,
        devices: Devices,
        link: LinkSession,
        runner: MissionRunner,
        watchdog: Watchdog,
        validator: CommandValidator,
        envelope: SafetyEnvelope,
        outbox: list[MissionEvent],
        store: StateStore | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._config = config
        self._devices = devices
        self._link = link
        self._runner = runner
        self._watchdog = watchdog
        self._validator = validator
        self._envelope = envelope
        # The runner appends its state transitions here rather than sending them.
        # A send can block on a socket, and the runner runs while this process
        # holds the watchdog's device lock -- so a slow network would be holding
        # up a Park. Required rather than defaulted: a Supervisor whose outbox is
        # not the one the runner writes to would silently lose every event.
        self._outbox = outbox
        self._store = store
        self._now = now or (lambda: datetime.now(UTC))

        self._owner: _Owner | None = None
        # A mission this agent was holding when it stopped. Reported to the cloud
        # and then forgotten -- see `recover`.
        self._recovered_mission: StoredMission | None = None
        self._saved_mission_state: str | None = None
        self._link.set_safety_envelope_configured(envelope.is_measured)

    # ------------------------------------------------------------------
    # Observable state
    # ------------------------------------------------------------------

    @property
    def link(self) -> LinkSession:
        return self._link

    @property
    def runner(self) -> MissionRunner:
        return self._runner

    @property
    def validator(self) -> CommandValidator:
        return self._validator

    @property
    def watchdog(self) -> Watchdog:
        return self._watchdog

    @property
    def audit(self) -> AuditLog:
        return self._validator.audit

    @property
    def owner(self) -> SessionOwnership | None:
        return self._owner.ownership if self._owner else None

    @property
    def recovered_mission(self) -> StoredMission | None:
        return self._recovered_mission

    # ------------------------------------------------------------------
    # Coming back
    # ------------------------------------------------------------------

    def recover(self) -> None:
        """Pick up what the last run left behind. Called once, before pumping.

        Two things come back and one deliberately does not.

        **Ownership comes back**, with the customer's spent nudge allowance. A
        restart that refilled the allowance would hand back the drift budget the
        limit exists to bound, and an agent that dropped ownership would refuse
        every command until the customer noticed and reopened their session.

        **A mission is reported, not resumed.** The agent has lost the state
        machine's progress -- which frame, which centring iteration, whether the
        slew had settled -- so continuing would be guessing about where a
        telescope is pointing. The mount is parked, the cloud is told through
        `AgentHello.resumeMissionId`, and the mission is the cloud's to close.
        """
        if self._store is None:
            return

        now = self._now()
        self._store.prune(now)
        self._restore_ownership(now)
        self._restore_mission()

    def _restore_ownership(self, now: datetime) -> None:
        assert self._store is not None
        stored = self._store.load_ownership()
        if stored is None:
            return

        if stored.expires_at is not None and stored.expires_at <= now:
            logger.info("the stored session had already expired; starting with no owner")
            self._store.clear_ownership()
            return

        self._owner = _Owner(
            ownership=SessionOwnership(
                mission_id=stored.mission_id,
                session_id=stored.session_id,
                user_id=stored.user_id,
            ),
            expires_at=stored.expires_at,
        )
        self._validator.set_ownership(self._owner.ownership)
        # After set_ownership, which resets it. The allowance is spent and must
        # stay spent across a restart.
        self._validator.set_nudge_offset(stored.cumulative_nudge_degrees)
        logger.info("recovered session %s", stored.session_id)

    def _restore_mission(self) -> None:
        assert self._store is not None
        stored = self._store.load_mission()
        if stored is None:
            return

        self._recovered_mission = stored
        self._link.set_resume_mission(stored.mission_id)
        logger.warning(
            "restarted holding mission %s (last seen %s); parking",
            stored.mission_id,
            stored.state,
        )
        self._audit_event(
            "MISSION_RECOVERED",
            detail=f"restarted holding mission {stored.mission_id}, last seen "
            f"{stored.state}; parked and reported to the cloud",
            context={"missionId": str(stored.mission_id), "state": stored.state},
        )

        with self._watchdog.device_lock:
            try:
                self._devices.mount.park()
            except Exception as error:
                logger.error("could not park after recovering a mission: %s", error)

    # ------------------------------------------------------------------
    # The pump
    # ------------------------------------------------------------------

    def pump(self) -> None:
        """One pass: read what arrived, act on it, advance the mission.

        Can raise -- `ProtocolVersionRefused` from the link is the case that
        matters, and it is fatal by design. `__main__` decides what a raised pass
        costs; everything the agent can recover from is handled below rather than
        thrown.
        """
        at_time = self._now()

        self._link.pump()
        if self._link.is_online:
            # Resets the watchdog's timers and clears its stopped-capture latch.
            # Only ever called from a link that is genuinely online, because this
            # is the single fact standing between a dead link and a Park.
            self._watchdog.link_is_online()
            # The hello that brought the link up carried the recovered mission.
            # It has been reported, so it stops being this agent's problem --
            # kept until now so a restart before reaching the cloud still reports
            # it on the next attempt.
            self._forget_recovered_mission()

        for message in self._link.take_received():
            self._handle(message, at_time)

        self._expire_owner(at_time)

        with self._watchdog.device_lock:
            self._runner.pump(at_time)

        # Outside the lock, deliberately. See `_outbox`.
        while self._outbox:
            self._link.send(self._outbox.pop(0).to_message())

        self._persist_mission()

        # Told at every pass, read only at the next hello. An agent that
        # reconnects mid-mission has to say which mission it still holds, or the
        # cloud will believe the observatory came back idle.
        if self._runner.is_active:
            self._link.set_resume_mission(uuid.UUID(self._runner.mission_id))
        elif self._recovered_mission is not None:
            self._link.set_resume_mission(self._recovered_mission.mission_id)
        else:
            self._link.set_resume_mission(None)

    # ------------------------------------------------------------------
    # Inbound messages
    # ------------------------------------------------------------------

    def _handle(self, message: dict, at_time: datetime) -> None:
        message_type = message.get("type")

        if message_type == "CLOUD_COMMAND":
            self._handle_command(message, at_time)
        elif message_type == "CLOUD_SESSION_UPDATE":
            self._handle_session_update(message)
        elif message_type == "CLOUD_SAFETY_ENVELOPE_UPDATE":
            self._handle_envelope_update(message)
        elif message_type == "CLOUD_ERROR":
            self._handle_cloud_error(message)
        elif message_type == "CLOUD_HEARTBEAT_ACK":
            pass
        else:
            logger.warning("ignoring an unrecognised message type: %r", message_type)

    def _handle_session_update(self, message: dict) -> None:
        """Take the cloud's word on who owns the observatory — and only that.

        The cloud decides ownership; it is the only party that can. What it
        cannot decide is whether a command is safe, which is why nothing in this
        method touches a device.

        A malformed or incomplete update clears ownership rather than leaving the
        previous owner in place. Ownership is the difference between a command
        being obeyed and refused, so an update this agent could not read must not
        leave a stale owner able to keep driving.
        """
        mission_id = _parse_uuid(message.get("missionId"))
        if mission_id is None:
            logger.error("session update without a usable missionId; clearing ownership")
            self._set_owner(None)
            return

        session_id = _parse_uuid(message.get("sessionId"))
        if session_id is None:
            logger.info("session revoked for mission %s", mission_id)
            self._set_owner(None)
            return

        user_id = _parse_uuid(message.get("userId"))
        if user_id is None:
            # Without the owning user there is no ownership to hold: the envelope
            # check compares userId against it. Refusing to guess is the whole
            # point of the second validation.
            logger.error(
                "session update for mission %s carried no userId; ownership not granted",
                mission_id,
            )
            self._set_owner(None)
            return

        self._set_owner(
            _Owner(
                ownership=SessionOwnership(
                    mission_id=mission_id, session_id=session_id, user_id=user_id
                ),
                expires_at=_parse_time(message.get("expiresAt")),
            )
        )

    def _set_owner(self, owner: _Owner | None) -> None:
        """Change the owner, and only when it has genuinely changed.

        Re-asserting the same session — which happens on every reconnect, because
        the cloud replays the current session to an agent that may have restarted
        — must not reset the customer's accumulated nudge offset. That offset is
        the only thing stopping a target being walked off frame, and a customer
        who could refresh it by dropping their connection would have no limit at
        all.
        """
        previous = self._owner
        if previous is not None and owner is not None and previous.ownership == owner.ownership:
            self._owner = owner
            self._persist_owner()
            return

        self._owner = owner
        self._validator.set_ownership(owner.ownership if owner else None)
        self._persist_owner()

    def _expire_owner(self, at_time: datetime) -> None:
        """Drop an owner whose session has run out, without waiting to be told.

        The cloud revokes lapsed sessions itself. This is the second check: a
        cloud that has stopped talking, or has been persuaded not to send the
        revocation, must not leave a customer holding the telescope past the
        slot they paid for.
        """
        owner = self._owner
        if owner is None or owner.expires_at is None or at_time < owner.expires_at:
            return

        logger.info(
            "session %s expired at %s; ownership cleared locally",
            owner.ownership.session_id,
            owner.expires_at.isoformat(),
        )
        self._audit_event(
            "SESSION_EXPIRED",
            detail=f"session {owner.ownership.session_id} lapsed at "
            f"{owner.expires_at.isoformat()}",
            context={"missionId": str(owner.ownership.mission_id)},
        )
        self._set_owner(None)

    def _handle_envelope_update(self, message: dict) -> None:
        """Store the measured envelope and hand it to everything that enforces it."""
        try:
            config = SafetyEnvelopeConfig.model_validate(message.get("envelope"))
        except Exception as error:
            # The previous envelope stays in force. Discarding it on a bad update
            # would relax the limits, which is the wrong direction to fail in.
            logger.error("refusing an unreadable safety envelope update: %s", error)
            return

        self._envelope = SafetyEnvelope(config=config, site=self._config.site)
        if self._store is not None:
            self._store.save_envelope(config)
        self._validator.set_envelope(self._envelope)
        self._runner.set_envelope(self._envelope)
        self._watchdog.set_config(config)
        self._link.set_safety_envelope_configured(self._envelope.is_measured)

        if self._envelope.is_measured:
            logger.info("safety envelope updated: MEASURED")
        else:
            logger.warning(
                "safety envelope updated: UNMEASURED — every slew will be refused "
                "until MAX_ALT_SAFE is measured"
            )

    def _handle_cloud_error(self, message: dict) -> None:
        code = message.get("code")
        detail = message.get("message", "")
        if message.get("fatal"):
            logger.error("cloud reported a fatal error (%s): %s", code, detail)
            self._link.drop(f"cloud error {code}")
            return
        logger.warning("cloud reported an error (%s): %s", code, detail)

    # ------------------------------------------------------------------
    # Commands
    # ------------------------------------------------------------------

    def _handle_command(self, message: dict, at_time: datetime) -> None:
        raw = message.get("command")
        if not isinstance(raw, dict):
            logger.warning("discarding a CLOUD_COMMAND with no command envelope")
            return

        ack = self._validator.validate(raw, at_time)
        if ack.accepted:
            refusal = self._execute(raw, at_time)
            if refusal is not None:
                ack = self._downgrade(ack, refusal)

        # The nudge allowance moves when a nudge is accepted, and it has to
        # survive a restart with the session that spent it.
        self._persist_owner()

        if _parse_uuid(ack.command_id) is None:
            # An envelope so malformed it had no readable commandId. The refusal
            # is in the audit log; there is nothing to send, because
            # AgentCommandAck.commandId is a uuid and an ack the cloud cannot
            # correlate would only be refused by its own schema.
            logger.warning("refused a command with no usable commandId; nothing to ack")
            return

        self._link.send(ack.to_message())

    def _downgrade(self, ack: Ack, refusal: Refusal) -> Ack:
        """Turn an accepted ack into a refusal because the observatory could not act.

        Recorded as its own audit kind. The command really was authorised and
        safe — the validator's ACCEPTED event is true and stays — and what
        followed is a separate fact about the state of the observatory. Collapsing
        the two would lose which of the agent's two independent checks refused it.
        """
        reason, detail = refusal
        self._audit_event(
            "COMMAND_NOT_EXECUTED",
            command_id=ack.command_id,
            reason=reason.value,
            detail=detail,
            context={"missionId": ack.mission_id},
        )
        logger.warning("command %s not executed: %s (%s)", ack.command_id, reason.value, detail)
        return Ack(
            command_id=ack.command_id,
            mission_id=ack.mission_id,
            status=CommandAcceptanceStatus.rejected,
            rejection_reason=reason,
            detail=detail,
        )

    def _execute(self, raw: dict, at_time: datetime) -> Refusal | None:
        """Carry out a command the validator accepted. Returns why it could not, or None."""
        try:
            envelope = CommandEnvelope.model_validate(raw)
        except Exception as error:  # pragma: no cover - the validator just parsed this
            return (
                CommandRejectionReason.malformed_payload,
                f"the envelope stopped parsing between validation and execution: {error}",
            )

        payload = envelope.payload.root
        unimplemented = UNIMPLEMENTED_COMMANDS.get(payload.kind)
        if unimplemented is not None:
            return (CommandRejectionReason.device_unavailable, unimplemented)

        with self._watchdog.device_lock:
            try:
                if payload.kind == "GOTO":
                    return self._execute_goto(envelope, payload, at_time)
                if payload.kind == "NUDGE":
                    return self._execute_nudge(payload)
                if payload.kind == "ABORT":
                    return self._execute_abort(envelope, at_time)
                if payload.kind == "PARK":
                    return self._execute_park(at_time)
            except DeviceError as error:
                # The watchdog decides what a device fault costs; this only
                # reports it. Its terminal sequence stops capture and parks.
                self._watchdog.report_device_fault(str(error))
                self._watchdog.evaluate()
                return (CommandRejectionReason.device_unavailable, str(error))

        return (  # pragma: no cover - every CommandType is either handled or listed above
            CommandRejectionReason.device_unavailable,
            f"{payload.kind} is not a command this agent knows how to carry out",
        )

    def _execute_goto(
        self, envelope: CommandEnvelope, payload, at_time: datetime
    ) -> Refusal | None:
        """Start a mission, or put a running one back on its booked target.

        A GOTO for the mission the agent already holds is a re-slew, not a second
        mission: the validator has already refused any command naming a different
        mission than the session owns, so the only way to arrive here with a
        different mission id is a cloud that contradicted itself. That is refused
        with MISSION_ALREADY_ACTIVE rather than obeyed.
        """
        if self._runner.is_active:
            if self._runner.mission_id != str(envelope.mission_id):
                return (
                    CommandRejectionReason.mission_already_active,
                    f"mission {self._runner.mission_id} is running; "
                    f"{envelope.mission_id} was not queued",
                )
            refusal = self._slew_to_equatorial(
                payload.coordinates.ra_hours, payload.coordinates.dec_degrees, at_time
            )
            if refusal is None:
                # Back on the booked target, so the drift this measured is gone.
                self._validator.reset_nudge_offset()
            return refusal

        if payload.recenter:
            return (
                CommandRejectionReason.no_active_mission,
                "a recentring GOTO arrived with no mission running; there is no "
                "booked target to return to",
            )

        try:
            self._runner.offer(
                MissionRequest(
                    mission_id=envelope.mission_id,
                    session_id=envelope.session_id,
                    user_id=envelope.user_id,
                    right_ascension_hours=payload.coordinates.ra_hours,
                    declination_degrees=payload.coordinates.dec_degrees,
                    operator_override=self._validator.operator_override(envelope),
                ),
                at_time,
            )
        except MissionAlreadyActive as error:
            return (CommandRejectionReason.mission_already_active, str(error))
        return None

    def _execute_nudge(self, payload) -> Refusal | None:
        """One bounded step from wherever the mount is now.

        The projected position was already checked against the envelope by the
        validator, reading the same mount status this does. The two readings are
        moments apart and a tracking mount drifts between them, which is why the
        step is bounded and why a mount that is slewing is refused outright: the
        one case where "wherever it is now" is not a position but a range.

        DV-028 has to decide what this means on the real mount. An absolute
        alt/az slew is exactly a nudge against `SimMount`; against a tracking
        Celestron it is a question about whether the offset is applied to the
        target or to the axes, and it must not be answered by copying this line.
        """
        status = self._devices.mount.status()
        if status.slewing:
            return (
                CommandRejectionReason.device_unavailable,
                "the mount is slewing; where a nudge would land is not yet fixed",
            )

        step = payload.step_arcminutes / ARCMINUTES_PER_DEGREE
        signed = step if payload.direction.value == "POSITIVE" else -step

        altitude = status.altitude_degrees
        azimuth = status.azimuth_degrees
        if payload.axis.value == "ALTITUDE":
            altitude += signed
        else:
            azimuth = normalise_azimuth(azimuth + signed)

        self._devices.mount.slew_to(altitude, azimuth)
        return None

    def _execute_abort(self, envelope: CommandEnvelope, at_time: datetime) -> Refusal | None:
        """Stop everything, then record why.

        The devices are stopped before the bookkeeping. A mission's outcome can
        be written a moment late; a mount that is still slewing cannot wait for
        it. The watchdog's terminal sequence is reused rather than reimplemented
        so that an abort does exactly what a heartbeat loss does.
        """
        reason = (
            MissionFailureReason.operator_abort
            if envelope.issued_by_operator_id is not None
            else MissionFailureReason.customer_cancelled
        )
        self._watchdog.operator_abort(f"ABORT command {envelope.command_id}")
        self._watchdog.evaluate()
        self._runner.cancel(at_time, reason)
        return None

    def _execute_park(self, at_time: datetime) -> Refusal | None:
        """Park, ending any mission that was running.

        Park is the answer to every unresolved condition, so it is never refused
        for being redundant: parking an already-parked mount is a no-op and the
        alternative is arguing with the one command that resolves a stuck
        observatory.
        """
        if self._runner.is_active:
            # The runner parks on every terminal path, including this one.
            self._runner.cancel(at_time, MissionFailureReason.operator_abort)
            return None

        if self._devices.mount.status().slewing:
            self._devices.mount.abort_slew()
        self._devices.mount.park()
        return None

    def _slew_to_equatorial(
        self, ra_hours: float, dec_degrees: float, at_time: datetime
    ) -> Refusal | None:
        if self._envelope.site is None:  # pragma: no cover - the validator refuses first
            return (
                CommandRejectionReason.device_unavailable,
                "observatory coordinates are not configured, so a target cannot be "
                "converted to a mount position",
            )
        if self._devices.mount.status().slewing:
            return (
                CommandRejectionReason.device_unavailable,
                "the mount is already slewing",
            )

        horizontal = equatorial_to_horizontal(ra_hours, dec_degrees, at_time, self._envelope.site)
        self._devices.mount.slew_to(horizontal.altitude_degrees, horizontal.azimuth_degrees)
        return None

    # ------------------------------------------------------------------
    # Plumbing
    # ------------------------------------------------------------------

    def _forget_recovered_mission(self) -> None:
        if self._recovered_mission is None:
            return
        self._recovered_mission = None
        if self._store is not None:
            self._store.clear_mission()

    def _persist_mission(self) -> None:
        """Keep the held mission on disk, and only when it changed.

        A write per state transition, not per pass. `is_active` is false once the
        mission reaches a terminal state, so a finished mission is cleared rather
        than recovered -- only an unfinished one comes back after a restart.
        """
        if self._store is None:
            return

        if self._runner.is_active:
            state = self._runner.state.value
            if state != self._saved_mission_state:
                assert self._runner.mission_id is not None
                self._store.save_mission(
                    uuid.UUID(self._runner.mission_id), state, self._now()
                )
                self._saved_mission_state = state
        elif self._saved_mission_state is not None:
            self._store.clear_mission()
            self._saved_mission_state = None

    def _persist_owner(self) -> None:
        if self._store is None:
            return
        owner = self._owner
        if owner is None:
            self._store.clear_ownership()
            return
        self._store.save_ownership(
            StoredOwnership(
                mission_id=owner.ownership.mission_id,
                session_id=owner.ownership.session_id,
                user_id=owner.ownership.user_id,
                expires_at=owner.expires_at,
                cumulative_nudge_degrees=self._validator.cumulative_nudge_degrees,
            )
        )

    def _audit_event(self, kind: str, **fields) -> None:
        self.audit.record(AuditEvent(occurred_at=self._now(), kind=kind, **fields))


def _parse_uuid(value) -> uuid.UUID | None:
    if not isinstance(value, str):
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _parse_time(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    # A naive timestamp would compare against an aware `now` and raise. Treating
    # it as UTC is the only reading the contract permits, which says date-time.
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def build_supervisor(
    config: AgentConfig,
    devices: Devices,
    connect,
    envelope: SafetyEnvelope | None = None,
    solver: PlateSolver | None = None,
    store: StateStore | None = None,
    clock: Clock | None = None,
    now: Callable[[], datetime] | None = None,
) -> Supervisor:
    """Assemble a supervisor from configuration. The only place the wiring lives.

    `pointing` and `attended` are handed to the validator here. Both have safe
    defaults, so forgetting either produces an agent that refuses every nudge for
    no visible reason rather than one that moves when it should not — which is
    why this function, and not a comment, is what guarantees it.

    A `store` makes three things durable in the same stroke: the audit log gains a
    sink, the idempotency set moves out of memory so a command retried across a
    restart is still refused, and a measured safety envelope survives a reboot
    during a network outage instead of coming back UNMEASURED.
    """
    from darkview_agent import __version__

    if config.observatory_id is None:
        raise ValueError(
            "an observatory id is required to open the link; set "
            "DARKVIEW_AGENT_OBSERVATORY_ID"
        )

    clock = clock or SystemClock()
    envelope = envelope if envelope is not None else SafetyEnvelope(site=config.site)

    # Only when the caller has not supplied measured limits. A stored envelope
    # must never quietly replace one that was passed in deliberately, and it can
    # only ever fill the unmeasured case -- which refuses every slew anyway, so
    # there is nothing it can relax.
    if store is not None and not envelope.is_measured:
        stored_config = store.load_envelope()
        if stored_config is not None:
            envelope = SafetyEnvelope(config=stored_config, site=config.site)
            logger.info("recovered the measured safety envelope from local state")

    audit = AuditLog(sink=store.append_audit if store else None)
    outbox: list[MissionEvent] = []

    link = LinkSession(
        observatory_id=config.observatory_id,
        agent_version=__version__,
        connect=connect,
        clock=clock,
        mode=devices.mount.mode,
    )
    watchdog = Watchdog(devices=devices, clock=clock, audit=audit, config=envelope.config)
    runner = MissionRunner(
        devices=devices,
        envelope=envelope,
        solver=solver or SimSolver(),
        clock=clock,
        emit=outbox.append,
    )
    validator = CommandValidator(
        envelope=envelope,
        audit=audit,
        seen=store,
        attended=config.attended,
        pointing=lambda: _mount_pointing(devices),
    )

    return Supervisor(
        config=config,
        devices=devices,
        link=link,
        runner=runner,
        watchdog=watchdog,
        validator=validator,
        envelope=envelope,
        outbox=outbox,
        store=store,
        now=now,
    )


def _mount_pointing(devices: Devices) -> tuple[float, float]:
    status = devices.mount.status()
    return status.altitude_degrees, status.azimuth_degrees


__all__ = [
    "DEFAULT_LOOP_INTERVAL_SECONDS",
    "UNIMPLEMENTED_COMMANDS",
    "Supervisor",
    "build_supervisor",
]
