"""Every timestamp the agent puts on the wire, in the spelling the cloud reads.

This file exists because of what Milestone S1 found. The agent wrote `+00:00`,
the cloud's generated validators accept only `Z`, and so every message the agent
ever sent was refused at the parse step -- the link never reached ONLINE against
the real service. RFC 3339 permits both spellings, so neither half was wrong on
its own; they simply did not agree, and no test compared them.

They still cannot compare directly: the validators are TypeScript. What these
tests can do is pin the agent's own output to one spelling, so that a change back
to `isoformat()` fails here instead of on a rooftop.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta, timezone

from darkview_agent.clock import wire_timestamp

# The shape z.iso.datetime() accepts: a UTC instant ending in Z, no offset.
CONTRACT_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")

AT = datetime(2026, 6, 21, 22, 0, tzinfo=UTC)


def test_a_utc_instant_is_written_with_a_z():
    assert CONTRACT_DATE_TIME.match(wire_timestamp(AT))
    assert wire_timestamp(AT) == "2026-06-21T22:00:00Z"


def test_isoformat_alone_would_not_be_accepted():
    # The bug, stated as a test. If this ever starts passing, the cloud's
    # validators have been relaxed and this module's reason for existing changed.
    assert not CONTRACT_DATE_TIME.match(AT.isoformat())
    assert AT.isoformat().endswith("+00:00")


def test_an_offset_instant_is_converted_rather_than_relabelled():
    tbilisi = timezone(timedelta(hours=4))
    same_moment = AT.astimezone(tbilisi)

    # The command ack used `astimezone()` with no argument, which reads the
    # machine's local zone -- so an ack sent from the observatory carried
    # +04:00. The instant must survive; only the spelling changes.
    assert wire_timestamp(same_moment) == "2026-06-21T22:00:00Z"


def test_a_naive_instant_is_taken_as_utc():
    assert wire_timestamp(AT.replace(tzinfo=None)) == "2026-06-21T22:00:00Z"


def test_the_default_is_now():
    before = datetime.now(UTC)
    stamped = wire_timestamp()
    after = datetime.now(UTC)

    assert CONTRACT_DATE_TIME.match(stamped)
    assert before <= datetime.fromisoformat(stamped) <= after


def test_every_message_the_link_sends_is_stamped_in_the_contract_spelling():
    from darkview_agent.command.validator import Ack, CommandAcceptanceStatus

    message = Ack(
        command_id=str(uuid.uuid4()),
        mission_id=str(uuid.uuid4()),
        status=CommandAcceptanceStatus.accepted,
    ).to_message()

    assert message["type"] == "AGENT_COMMAND_ACK"
    assert CONTRACT_DATE_TIME.match(message["sentAt"])
