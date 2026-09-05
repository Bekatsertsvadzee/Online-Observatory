"""DV-025 — command envelope validation.

Each acceptance criterion, and the ordering between them.
"""

from __future__ import annotations

from datetime import timedelta
from uuid import uuid4

import pytest

from contracts.models import CommandAcceptanceStatus, CommandRejectionReason
from darkview_agent.command.validator import (
    BoundedSeenCommands,
    CommandValidator,
    SessionOwnership,
)
from darkview_agent.safety.envelope import SafetyEnvelope
from tests.command_fixtures import (
    NOW,
    OWNERSHIP,
    abort,
    envelope,
    goto,
    goto_payload,
    nudge,
    nudge_payload,
    park,
)
from tests.envelope_fixtures import NOON, TBILISI, build_config, mask_entry, sector

#: Where the simulated mount sits unless a test moves it: comfortably inside the
#: envelope, so a nudge test isolates the rule it cares about.
RESTING_POINTING = (40.0, 180.0)


def validator(
    *,
    measured: bool = True,
    owned: bool = True,
    attended: bool = False,
    pointing: tuple[float, float] | None = RESTING_POINTING,
    **config,
) -> CommandValidator:
    safety = SafetyEnvelope(
        config=build_config(
            max_altitude_degrees=68.0 if measured else None,
            min_altitude_degrees=config.pop("min_altitude_degrees", 20.0),
            **config,
        ),
        site=TBILISI,
    )
    instance = CommandValidator(
        envelope=safety,
        attended=attended,
        pointing=None if pointing is None else lambda: pointing,
    )
    if owned:
        instance.set_ownership(OWNERSHIP)
    return instance


# --------------------------------------------------------------------------
# Criterion 1 and 6 — idempotency
# --------------------------------------------------------------------------


def test_a_replayed_command_id_is_acked_duplicate():
    """Criterion 1."""
    subject = validator()
    command = park()

    first = subject.validate(command, NOW)
    second = subject.validate(command, NOW)

    assert first.status is CommandAcceptanceStatus.accepted
    assert second.status is CommandAcceptanceStatus.duplicate
    assert second.rejection_reason is CommandRejectionReason.duplicate_command_id


def test_only_one_effective_verdict_is_ever_produced_for_a_command_id():
    """Criterion 6.

    Every arrival gets exactly one ack — a repeat is answered, because retries
    exist precisely because acks get lost, and an unanswered repeat would leave
    the cloud waiting forever. But only the first arrival produces a real
    verdict; the rest are DUPLICATE and the device is never touched again.
    """
    subject = validator()
    command = park()

    acks = [subject.validate(command, NOW) for _ in range(5)]

    verdicts = [
        ack
        for ack in acks
        if ack.status
        in (CommandAcceptanceStatus.accepted, CommandAcceptanceStatus.rejected)
    ]
    assert len(verdicts) == 1
    assert all(ack.status is CommandAcceptanceStatus.duplicate for ack in acks[1:])


def test_a_replay_of_a_rejected_command_is_still_duplicate_not_re_evaluated():
    subject = validator()
    command = park(session_id=uuid4())

    first = subject.validate(command, NOW)
    second = subject.validate(command, NOW)

    assert first.rejection_reason is CommandRejectionReason.wrong_session
    assert second.rejection_reason is CommandRejectionReason.duplicate_command_id


def test_different_command_ids_are_evaluated_independently():
    subject = validator()
    assert subject.validate(park(), NOW).accepted is True
    assert subject.validate(park(), NOW).accepted is True


def test_the_in_memory_seen_set_is_bounded():
    subject = CommandValidator(seen=BoundedSeenCommands(capacity=3))
    subject.set_ownership(OWNERSHIP)

    commands = [park() for _ in range(5)]
    for command in commands:
        subject.validate(command, NOW)

    assert subject.has_seen(commands[-1]["commandId"]) is True
    assert subject.has_seen(commands[0]["commandId"]) is False


# --------------------------------------------------------------------------
# Criterion 2 — expiry
# --------------------------------------------------------------------------


def test_an_expired_command_is_refused():
    """Criterion 2."""
    subject = validator()
    command = park(expires_at=NOW - timedelta(seconds=1))

    ack = subject.validate(command, NOW)

    assert ack.status is CommandAcceptanceStatus.expired
    assert ack.rejection_reason is CommandRejectionReason.command_expired


def test_a_command_expiring_exactly_now_is_refused():
    subject = validator()
    ack = subject.validate(park(expires_at=NOW), NOW)
    assert ack.rejection_reason is CommandRejectionReason.command_expired


def test_a_command_expiring_in_a_moment_is_accepted():
    subject = validator()
    ack = subject.validate(park(expires_at=NOW + timedelta(milliseconds=1)), NOW)
    assert ack.accepted is True


def test_a_command_queued_before_a_reconnect_does_not_fire_after_it():
    """Criterion 2, the case it exists for.

    The command was minted while the link was down and delivered when it came
    back. Wall-clock time has passed even though nothing was processed.
    """
    subject = validator()
    command = goto(expires_at=NOW + timedelta(seconds=30))

    delivered_after_outage = NOW + timedelta(minutes=20)
    ack = subject.validate(command, delivered_after_outage)

    assert ack.status is CommandAcceptanceStatus.expired
    assert ack.rejection_reason is CommandRejectionReason.command_expired


# --------------------------------------------------------------------------
# Criterion 3 — session, user and mission ownership
# --------------------------------------------------------------------------


def test_a_command_from_another_session_is_refused():
    """Criterion 3."""
    subject = validator()
    ack = subject.validate(park(session_id=uuid4()), NOW)
    assert ack.rejection_reason is CommandRejectionReason.wrong_session


def test_a_command_from_another_user_is_refused():
    subject = validator()
    ack = subject.validate(park(user_id=uuid4()), NOW)
    assert ack.rejection_reason is CommandRejectionReason.wrong_user


def test_a_command_for_another_mission_is_refused():
    subject = validator()
    ack = subject.validate(park(mission_id=uuid4()), NOW)
    assert ack.rejection_reason is CommandRejectionReason.wrong_mission


def test_no_command_is_authorised_when_the_agent_holds_no_mission():
    subject = validator(owned=False)
    ack = subject.validate(park(), NOW)
    assert ack.rejection_reason is CommandRejectionReason.no_active_mission


def test_handing_the_observatory_to_a_new_session_changes_who_is_authorised():
    subject = validator()
    new_session = SessionOwnership(
        mission_id=uuid4(), session_id=uuid4(), user_id=uuid4()
    )

    assert subject.validate(park(), NOW).accepted is True
    subject.set_ownership(new_session)
    assert subject.validate(park(), NOW).rejection_reason is (
        CommandRejectionReason.wrong_session
    )


# --------------------------------------------------------------------------
# Criterion 4 — payload kind must match the envelope type
# --------------------------------------------------------------------------


def test_a_goto_carrying_a_nudge_payload_is_refused():
    """Criterion 4, exactly as written."""
    subject = validator()
    command = envelope(command_type="GOTO", payload=nudge_payload())

    ack = subject.validate(command, NOW)

    assert ack.rejection_reason is CommandRejectionReason.payload_type_mismatch
    assert "GOTO" in ack.detail and "NUDGE" in ack.detail


def test_a_park_carrying_a_goto_payload_is_refused():
    subject = validator()
    ack = subject.validate(envelope(command_type="PARK", payload=goto_payload()), NOW)
    assert ack.rejection_reason is CommandRejectionReason.payload_type_mismatch


def test_a_matching_type_and_payload_passes_the_check():
    subject = validator()
    assert subject.validate(park(), NOW).accepted is True


def test_a_malformed_envelope_is_refused_without_crashing():
    subject = validator()
    ack = subject.validate({"commandId": "not-a-uuid", "type": "GOTO"}, NOW)
    assert ack.rejection_reason is CommandRejectionReason.malformed_payload


def test_an_unknown_payload_kind_is_refused():
    subject = validator()
    command = envelope(command_type="PARK", payload={"kind": "LAUNCH_ROCKET"})
    ack = subject.validate(command, NOW)
    assert ack.rejection_reason is CommandRejectionReason.malformed_payload


# --------------------------------------------------------------------------
# Criterion 5 — the safety envelope has the last word
# --------------------------------------------------------------------------


def test_a_goto_below_the_minimum_altitude_is_refused_with_the_safety_reason():
    """Criterion 5: the cloud approved it; the agent refuses it anyway."""
    subject = validator(min_altitude_degrees=20.0)
    # Declination -60 is never more than a few degrees up from Tbilisi.
    command = goto(payload=goto_payload(ra_hours=6.0, dec_degrees=-60.0))

    ack = subject.validate(command, NOW)

    assert ack.status is CommandAcceptanceStatus.rejected
    assert ack.rejection_reason is CommandRejectionReason.safety_below_min_altitude


def test_an_unmeasured_envelope_refuses_a_goto():
    subject = validator(measured=False)
    ack = subject.validate(goto(), NOW)
    assert ack.rejection_reason is CommandRejectionReason.safety_envelope_unmeasured


def test_a_goto_within_the_envelope_is_accepted():
    """RA 18h, Dec 0 sits at about 46 degrees from Tbilisi at this instant:
    above the 20-degree minimum and below the 68-degree MAX_ALT_SAFE."""
    subject = validator(min_altitude_degrees=20.0)
    ack = subject.validate(goto(payload=goto_payload(ra_hours=18.0, dec_degrees=0.0)), NOW)
    assert ack.accepted is True, ack.detail


def test_a_goto_above_max_alt_safe_is_refused():
    """The same sky, a target near the zenith: the fork clearance limit applies.

    RA 18h Dec +40 culminates at about 79 degrees from this latitude, which is
    where the rear of the camera train stops clearing the fork base.
    """
    subject = validator(min_altitude_degrees=20.0)
    ack = subject.validate(goto(payload=goto_payload(ra_hours=18.0, dec_degrees=40.0)), NOW)
    assert ack.rejection_reason is CommandRejectionReason.safety_above_max_altitude


# --------------------------------------------------------------------------
# The daylight lock is lifted by the operator being here, not by the cloud
# saying so
# --------------------------------------------------------------------------

# A target the Sun cannot object to at local noon: 30 degrees up in the north,
# 77 degrees from the Sun, inside both altitude limits. Only the daylight lock
# can refuse it.
DAYLIGHT_SAFE = dict(ra_hours=15.0, dec_degrees=75.0)


def test_the_cloud_cannot_lift_the_daylight_lock_on_an_unattended_agent():
    """The second validation exists to withhold exactly this trust.

    `issuedByOperatorId` is a claim the cloud makes. A compromised or simply
    buggy cloud must not be able to slew the mount in full daylight with nobody
    at the observatory.
    """
    subject = validator(attended=False)
    command = goto(payload=goto_payload(**DAYLIGHT_SAFE), issued_by_operator_id=uuid4())

    ack = subject.validate(command, NOON)

    assert ack.status is CommandAcceptanceStatus.rejected
    assert ack.rejection_reason is CommandRejectionReason.safety_daylight_lock


def test_an_attended_agent_accepts_the_same_command():
    """Attended terrestrial testing is what the override is for."""
    subject = validator(attended=True)
    command = goto(payload=goto_payload(**DAYLIGHT_SAFE), issued_by_operator_id=uuid4())

    ack = subject.validate(command, NOON)

    assert ack.accepted is True, ack.detail


def test_being_attended_alone_does_not_lift_the_lock():
    """Both conditions, always: an operator here AND an operator-issued command.

    An attended agent still refuses an ordinary customer GOTO in daylight.
    """
    subject = validator(attended=True)

    ack = subject.validate(goto(payload=goto_payload(**DAYLIGHT_SAFE)), NOON)

    assert ack.rejection_reason is CommandRejectionReason.safety_daylight_lock


def test_the_sun_exclusion_survives_an_attended_operator_override():
    """No flag, override or configuration value widens the Sun exclusion.

    RA 6h Dec +23 is roughly where the Sun itself is on this date.
    """
    subject = validator(attended=True)
    command = goto(
        payload=goto_payload(ra_hours=6.0, dec_degrees=23.0),
        issued_by_operator_id=uuid4(),
    )

    ack = subject.validate(command, NOON)

    assert ack.rejection_reason is CommandRejectionReason.safety_sun_exclusion


def test_a_nudge_beyond_the_cumulative_limit_is_refused():
    subject = validator(nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.2)

    # 12 arcminutes is 0.2 degrees; three of them reach 0.6, past the 0.5 limit.
    assert subject.validate(nudge(payload=nudge_payload(12.0)), NOW).accepted is True
    assert subject.validate(nudge(payload=nudge_payload(12.0)), NOW).accepted is True
    third = subject.validate(nudge(payload=nudge_payload(12.0)), NOW)

    assert third.rejection_reason is CommandRejectionReason.safety_nudge_limit_exceeded


def test_a_nudge_step_larger_than_permitted_is_refused():
    subject = validator(nudge_max_degrees=5.0, nudge_rate_degrees_per_second=0.1)
    ack = subject.validate(nudge(payload=nudge_payload(30.0)), NOW)
    assert ack.rejection_reason is CommandRejectionReason.safety_slew_rate


def test_a_refused_nudge_does_not_consume_the_cumulative_budget():
    """A rejection must not count against the customer's remaining nudges."""
    subject = validator(nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.1)

    subject.validate(nudge(payload=nudge_payload(30.0)), NOW)  # refused: step too big
    assert subject.cumulative_nudge_degrees == 0.0


def test_handing_over_the_session_resets_the_nudge_budget():
    subject = validator(nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.2)
    subject.validate(nudge(payload=nudge_payload(12.0)), NOW)
    assert subject.cumulative_nudge_degrees > 0.0

    subject.set_ownership(OWNERSHIP)
    assert subject.cumulative_nudge_degrees == 0.0


# --------------------------------------------------------------------------
# A nudge is judged on where it lands, not only on how far it moves
#
# `nudgeMaxDegrees` is measured from the target the customer booked.
# `MAX_ALT_SAFE` is measured from the physical optical train. A step can sit
# inside every relative limit and still take the mount somewhere the envelope
# forbids, so the projected pointing is checked too.
# --------------------------------------------------------------------------


def test_a_nudge_may_not_climb_past_the_measured_max_altitude():
    """The whole point. 0.2 degrees is well within the 0.5 degree allowance."""
    subject = validator(
        nudge_max_degrees=0.5,
        nudge_rate_degrees_per_second=0.2,
        pointing=(67.9, 180.0),  # max_altitude_degrees is 68.0
    )

    ack = subject.validate(nudge(payload=nudge_payload(12.0)), NOW)

    assert ack.rejection_reason is CommandRejectionReason.safety_above_max_altitude


def test_a_nudge_may_not_sink_below_the_minimum_altitude():
    subject = validator(
        nudge_max_degrees=0.5,
        nudge_rate_degrees_per_second=0.2,
        min_altitude_degrees=20.0,
        pointing=(20.1, 180.0),
    )

    ack = subject.validate(
        nudge(payload=nudge_payload(12.0, direction="NEGATIVE")), NOW
    )

    assert ack.rejection_reason is CommandRejectionReason.safety_below_min_altitude


def test_a_nudge_may_not_drop_below_the_surveyed_horizon():
    subject = validator(
        nudge_max_degrees=0.5,
        nudge_rate_degrees_per_second=0.2,
        horizon_mask=[mask_entry(180.0, 35.0)],
        pointing=(35.1, 180.0),
    )

    ack = subject.validate(
        nudge(payload=nudge_payload(12.0, direction="NEGATIVE")), NOW
    )

    assert ack.rejection_reason is CommandRejectionReason.safety_horizon_mask


def test_a_nudge_may_not_turn_into_a_forbidden_azimuth_sector():
    """Cable wrap does not care that the step was a small one."""
    subject = validator(
        nudge_max_degrees=0.5,
        nudge_rate_degrees_per_second=0.2,
        forbidden_azimuth_sectors=[sector(180.0, 200.0)],
        pointing=(40.0, 179.9),
    )

    ack = subject.validate(
        nudge(payload=nudge_payload(12.0, axis="AZIMUTH")), NOW
    )

    assert ack.rejection_reason is CommandRejectionReason.safety_forbidden_azimuth


def test_a_nudge_refused_on_pointing_does_not_consume_the_budget():
    """Criterion 3 of the issue: a refused nudge did not move the telescope."""
    subject = validator(
        nudge_max_degrees=0.5,
        nudge_rate_degrees_per_second=0.2,
        pointing=(67.9, 180.0),
    )

    subject.validate(nudge(payload=nudge_payload(12.0)), NOW)

    assert subject.cumulative_nudge_degrees == 0.0


def test_a_nudge_is_refused_when_the_mount_position_cannot_be_read():
    """Fail closed. A nudge is relative, so without a position there is nothing
    to judge -- unlike a GOTO, which names where it is going."""
    subject = validator(
        nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.2, pointing=None
    )

    ack = subject.validate(nudge(payload=nudge_payload(12.0)), NOW)

    assert ack.rejection_reason is CommandRejectionReason.device_unavailable
    assert subject.cumulative_nudge_degrees == 0.0


def test_a_mount_that_raises_is_the_same_answer_as_no_mount():
    safety = SafetyEnvelope(
        config=build_config(max_altitude_degrees=68.0), site=TBILISI
    )

    def unavailable() -> tuple[float, float]:
        raise RuntimeError("mount not connected")

    subject = CommandValidator(envelope=safety, pointing=unavailable)
    subject.set_ownership(OWNERSHIP)

    ack = subject.validate(nudge(payload=nudge_payload(3.0)), NOW)

    assert ack.rejection_reason is CommandRejectionReason.device_unavailable


def test_a_nudge_that_lands_inside_the_envelope_is_still_accepted():
    """The absolute check must not refuse an ordinary nudge."""
    subject = validator(
        nudge_max_degrees=0.5, nudge_rate_degrees_per_second=0.2, pointing=(40.0, 180.0)
    )

    ack = subject.validate(nudge(payload=nudge_payload(12.0)), NOW)

    assert ack.accepted is True
    assert subject.cumulative_nudge_degrees == pytest.approx(0.2)


def test_a_nudge_may_not_step_into_the_sun_exclusion():
    """A nudge toward the Sun is a nudge toward the Sun.

    At local solar noon on this date the Sun sits at altitude 71.7, azimuth 178.2
    over Tbilisi. Altitude 40 due south is 31.7 degrees away and permitted; two
    degrees higher is 29.7 and is not. So the refusal below can only come from
    checking where the nudge *lands*, never from where the mount already is.

    Attended, so the daylight lock is lifted and the Sun exclusion is the rule
    under test rather than the one that happens to fire first.
    """
    subject = validator(
        nudge_max_degrees=3.0,
        nudge_rate_degrees_per_second=2.0,
        attended=True,
        pointing=(40.0, 180.0),
    )

    # A small step stays outside the exclusion and is accepted, which pins the
    # starting position as permitted.
    assert subject.validate(
        nudge(payload=nudge_payload(6.0), issued_by_operator_id=uuid4()), NOON
    ).accepted is True

    # The same rule, the same position, a bigger step. Only the projection differs.
    ack = subject.validate(
        nudge(payload=nudge_payload(120.0), issued_by_operator_id=uuid4()), NOON
    )

    assert ack.rejection_reason is CommandRejectionReason.safety_sun_exclusion


# --------------------------------------------------------------------------
# Recovery commands stay available
# --------------------------------------------------------------------------


def test_park_is_accepted_even_when_the_envelope_is_unmeasured():
    """Park is the answer to every unresolved condition.

    Refusing it because MAX_ALT_SAFE has never been measured would strand the
    telescope in exactly the situation Park exists to resolve.
    """
    subject = validator(measured=False)
    assert subject.validate(park(), NOW).accepted is True


def test_abort_is_accepted_even_when_the_envelope_is_unmeasured():
    subject = validator(measured=False)
    assert subject.validate(abort(), NOW).accepted is True


def test_park_is_still_refused_from_the_wrong_session():
    """Exempt from the pointing check is not exempt from authorisation."""
    subject = validator(measured=False)
    ack = subject.validate(park(session_id=uuid4()), NOW)
    assert ack.rejection_reason is CommandRejectionReason.wrong_session


def test_an_expired_park_is_still_refused():
    subject = validator()
    ack = subject.validate(park(expires_at=NOW - timedelta(seconds=1)), NOW)
    assert ack.rejection_reason is CommandRejectionReason.command_expired


# --------------------------------------------------------------------------
# Ordering between the checks
# --------------------------------------------------------------------------


def test_idempotency_is_checked_before_expiry():
    """A repeat of an already-decided command is DUPLICATE, not EXPIRED."""
    subject = validator()
    command = park(expires_at=NOW + timedelta(seconds=30))
    subject.validate(command, NOW)

    later = subject.validate(command, NOW + timedelta(minutes=5))
    assert later.status is CommandAcceptanceStatus.duplicate


def test_expiry_is_checked_before_authorisation():
    """An expired command from the wrong session reports expiry.

    Both are true; expiry is the one that stops the command being meaningful at
    all, and reporting the more fundamental problem helps whoever reads the log.
    """
    subject = validator()
    command = park(session_id=uuid4(), expires_at=NOW - timedelta(seconds=1))
    ack = subject.validate(command, NOW)
    assert ack.rejection_reason is CommandRejectionReason.command_expired


def test_authorisation_is_checked_before_the_payload_kind():
    subject = validator()
    command = envelope(
        command_type="GOTO", payload=nudge_payload(), session_id=uuid4()
    )
    ack = subject.validate(command, NOW)
    assert ack.rejection_reason is CommandRejectionReason.wrong_session


def test_the_payload_kind_is_checked_before_safety():
    """A mismatched payload cannot be safety-checked: there is nothing coherent
    to check."""
    subject = validator(measured=False)
    command = envelope(command_type="GOTO", payload=nudge_payload())
    ack = subject.validate(command, NOW)
    assert ack.rejection_reason is CommandRejectionReason.payload_type_mismatch


# --------------------------------------------------------------------------
# Criterion 7 — every rejection is recorded locally
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        (park(session_id=uuid4()), CommandRejectionReason.wrong_session),
        (park(user_id=uuid4()), CommandRejectionReason.wrong_user),
        (park(mission_id=uuid4()), CommandRejectionReason.wrong_mission),
        (
            park(expires_at=NOW - timedelta(seconds=1)),
            CommandRejectionReason.command_expired,
        ),
        (
            envelope(command_type="GOTO", payload=nudge_payload()),
            CommandRejectionReason.payload_type_mismatch,
        ),
    ],
)
def test_every_rejection_writes_an_audit_event(command, expected):
    """Criterion 7."""
    subject = validator()
    ack = subject.validate(command, NOW)

    assert ack.rejection_reason is expected
    rejections = subject.audit.events_of_kind("COMMAND_REJECTED")
    assert len(rejections) == 1
    assert rejections[0].reason == expected.value
    assert rejections[0].command_id == command["commandId"]
    assert rejections[0].detail


def test_an_acceptance_is_recorded_too():
    subject = validator()
    subject.validate(park(), NOW)
    assert len(subject.audit.events_of_kind("COMMAND_ACCEPTED")) == 1


def test_a_duplicate_is_recorded_separately_from_the_original_verdict():
    subject = validator()
    command = park()
    subject.validate(command, NOW)
    subject.validate(command, NOW)

    events = subject.audit.events_for_command(command["commandId"])
    kinds = [event.kind for event in events]
    assert kinds == ["COMMAND_ACCEPTED", "COMMAND_DUPLICATE"]


def test_a_malformed_envelope_is_recorded():
    subject = validator()
    subject.validate({"commandId": "nonsense"}, NOW)
    rejections = subject.audit.events_of_kind("COMMAND_REJECTED")
    assert len(rejections) == 1
    assert rejections[0].reason == CommandRejectionReason.malformed_payload.value


# --------------------------------------------------------------------------
# The ack that goes on the wire
# --------------------------------------------------------------------------


def test_the_ack_serialises_to_the_contract_shape():
    subject = validator()
    ack = subject.validate(park(session_id=uuid4()), NOW)
    message = ack.to_message()

    assert message["type"] == "AGENT_COMMAND_ACK"
    assert message["status"] == "REJECTED"
    assert message["rejectionReason"] == "WRONG_SESSION"
    assert message["commandId"] == ack.command_id


def test_an_accepted_ack_carries_no_rejection_reason():
    subject = validator()
    message = subject.validate(park(), NOW).to_message()
    assert message["status"] == "ACCEPTED"
    assert message["rejectionReason"] is None


# --------------------------------------------------------------------------
# Fail-closed when the agent does not know where it is
# --------------------------------------------------------------------------


def test_a_goto_is_refused_when_the_site_is_not_configured():
    """Without coordinates the agent cannot compute the target's altitude or its
    separation from the Sun. It refuses rather than assuming either."""
    subject = CommandValidator(
        envelope=SafetyEnvelope(config=build_config(max_altitude_degrees=68.0), site=None)
    )
    subject.set_ownership(OWNERSHIP)

    ack = subject.validate(goto(), NOW)

    assert ack.status is CommandAcceptanceStatus.rejected
    assert ack.rejection_reason is CommandRejectionReason.safety_sun_exclusion
    assert "coordinates are not configured" in ack.detail


def test_park_still_works_when_the_site_is_not_configured():
    """Recovery must not depend on knowing where the observatory is."""
    subject = CommandValidator(envelope=SafetyEnvelope(config=None, site=None))
    subject.set_ownership(OWNERSHIP)
    assert subject.validate(park(), NOW).accepted is True


def test_the_current_owner_is_readable():
    subject = validator()
    assert subject.ownership == OWNERSHIP
    subject.set_ownership(None)
    assert subject.ownership is None


def test_the_envelope_can_be_replaced_when_the_cloud_sends_a_new_one():
    """DV-023's envelope arrives over the link and can change mid-session, for
    instance when MAX_ALT_SAFE is recorded after qualification."""
    subject = validator(measured=False)
    assert subject.validate(goto(), NOW).rejection_reason is (
        CommandRejectionReason.safety_envelope_unmeasured
    )

    subject.set_envelope(
        SafetyEnvelope(
            config=build_config(max_altitude_degrees=68.0, min_altitude_degrees=20.0),
            site=TBILISI,
        )
    )
    accepted = subject.validate(goto(payload=goto_payload(18.0, 0.0)), NOW)
    assert accepted.accepted is True, accepted.detail
