# ADR-079 — A Booked Session Runs for Its Whole Slot

- **Date:** 2026-11-01
- **Status:** PROPOSED
- **Decided by:** project maintainer (pending; direction given 2026-11-01, decisions D1, D2
  and D4 of the booked-session spec)
- **Amends:** ADR-018 §1 (what the start action is); ADR-004's transition table (not its
  states)
- **Relates to:** ADR-004 (mission state machine), ADR-012 (capture storage and upload),
  ADR-015 §2 (what a slot can deliver), ADR-046 (a reconnect is not a restart), ADR-062
  (the outbox), clients ADR-063 ("Best in the sky"), clients ADR-072 (15 minutes to 4
  hours), ADR-080 (image health), ADR-081 (unattended real operation)

## Context

A customer can now buy any quarter hour from 15 minutes to 4 hours (clients ADR-072), but
the mission they buy does not last that long. The agent holds OBSERVING for
`DEFAULT_OBSERVING_SECONDS` (90 s, marked PROVISIONAL in `mission/runner.py` because "the
agent is not told" the slot's length), takes at most one capture, and parks. The rest of
the slot is paid for and empty.

The agent is in fact told: `CloudSessionUpdate.expiresAt` is the slot's end
(`sessionExpiry` in `apps/api/src/features/missions/session.ts`), and `_expire_owner`
already reads it. Nothing uses it as the observing deadline.

The maintainer wants the whole path to hold for the whole slot: open the page inside the
slot, the telescope starts, the customer may switch among objects that are up now, the
picture stays good, every capture is kept, and at the slot's end the telescope parks and
the customer is sent what they captured.

## Decision

### 1. Opening the session page inside the slot is the start action

ADR-018 §1 said the customer starts their booked mission by pressing Start. That stays
true in substance — the customer still begins it, inside their own window — but the act
is opening the page: the client calls `POST /missions/{missionId}/start` on every open
and every reload while now is inside the slot, without a button. Before the slot the page
counts down and calls nothing; after it, nothing.

The endpoint is unchanged. On a SCHEDULED mission it starts it (ADR-018); on a live one it
rotates the session, so a reload never restarts anything. ADR-018 §2's refusals stand,
and a refused start may be retried later in the slot. ADR-018 §4's no-show sweep stands:
a slot nobody opens never moves the mount.

This is not ADR-018's rejected "scheduler that starts the mission at slot start": nothing
starts unless a signed-in owner has the page open.

### 2. The mission observes until the slot's end

The agent's observing deadline is the session's `expiresAt`. The 90-second timeout goes.
At that instant, on its own clock, the agent:

1. finishes an in-flight capture early with the frames already stacked (CAPTURING →
   PROCESSING), and delivers it;
2. moves the mission to COMPLETE (from PROCESSING, or straight from OBSERVING when no
   capture was in flight);
3. stops capture and Parks.

The cloud does the same from its side. A realtime sweep, beside ADR-018 §4's, finds live
missions whose `sessionEndsAt` has passed and sends `CloudSessionUpdate` with a null
`sessionId` and `endReason: SLOT_ENDED`, which tells the agent to finish now even if its
clock lags. The cloud never mints a PARK for this: ending a session is a message that can
only make the observatory safer, on the pattern ADR-024 §3 set for weather.

A null `sessionId` without `endReason` stays what it is today — a revocation or a
rotation — and does not end the mission.

### 3. Many captures

CAPTURE may be sent repeatedly while the session runs. Each is its own command, its own
ADR-012 upload grants and its own `Capture`. The cloud refuses one while another is in
flight (`CAPTURE_IN_PROGRESS`), within 30 seconds of the previous one's issue
(`CAPTURE_COOLDOWN`), past 50 in a mission (`CAPTURE_LIMIT_REACHED`), and in the last
60 seconds of the slot (`SESSION_ENDING`). Each capture records the target the mount was
on when it ran (`AgentCaptureReady.targetId`).

### 4. Switching objects: RETARGET, among objects visible now, with a 10-minute dwell

`GET /missions/{missionId}/targets` lists the objects the session may switch to at this
instant, best first. It applies exactly the rules `GET /targets/visibility` applies for
booking — altitude limits, the measured maximum, the horizon mask, forbidden sectors, Sun
exclusion and daylight, Moon separation, field fit — across the window from now to
min(slot end, now + 10 minutes), so a chosen object stays up for its whole dwell.

`RETARGET` names one of those targets by id. The cloud computes its coordinates now and
mints a `RETARGET` envelope; the agent re-validates it against its own envelope and its
own dwell lock. Refusals, in order: not OBSERVING (`MISSION_BUSY`), under 5 minutes left
(`SESSION_ENDING`), already on it (`CONFLICT`), dwell lock (`DWELL_LOCKED`, with when it
lifts), not visible now (`TARGET_NOT_OBSERVABLE`), pointing pre-check (`SAFETY_REFUSED`).

**The dwell lock is 600 seconds**, measured from when the agent accepted the GOTO or
RETARGET that put the mount on the current object. It spares the mount: the owner asked
for it. It is waived while the agent reports the picture UNRECOVERED (ADR-080) and when
the current object is no longer in the visible-now list (it is setting). RECENTER returns
to the current object, not the booked one, and does not reset the lock.

The booked target is the first object; a booking without one already gets "Best in the
sky" (clients ADR-063). `Mission.targetId` stays the booked target; the new
`Mission.currentTargetId` follows RETARGET.

### 5. Transitions, not states

ADR-004 says nobody adds a state, and none is added. The machine gains four edges, applied
in all three copies of the table (`apps/realtime/src/link/store.ts`, its API mirror, and
the agent's runner):

| Edge                                         | When                                         |
| -------------------------------------------- | -------------------------------------------- |
| PROCESSING → OBSERVING                       | a capture was delivered and the slot runs on |
| OBSERVING → SLEWING                          | a RETARGET was accepted                      |
| OBSERVING → COMPLETE                         | the slot ended with no capture in flight     |
| (existing) CAPTURING → PROCESSING → COMPLETE | the slot ended mid-capture                   |

Because PROCESSING now returns to OBSERVING, **PROCESSING becomes a live state**: it joins
`LIVE_MISSION_STATES` and the `Mission_active_per_observatory_unique` partial index
(a migration), or a mission would drop out of the one-mission-per-observatory guarantee
for the moment it spends processing.

Parking after COMPLETE is not a state either. Clients read it from
`MissionTelemetryUpdate.endPhase` — FINISHING, PARKING, PARKED — which the cloud derives
from the mission state and the agent's `parked` telemetry, and keeps sending for up to
300 seconds after the mission ends.

### 6. The session ends with a message and an email

When the mission is terminal and the mount reports parked (or 300 seconds pass without
that report), the cloud sends `MISSION_SESSION_ENDED` once on the mission channel, with
every capture id, and writes one `SESSION_SUMMARY` email to the outbox (ADR-062) for any
mission that reached OBSERVING: target names, capture times and thumbnails, a link to the
Collection. Per-capture `CAPTURE_READY` emails are not sent for a booked session; the
summary replaces them, so a two-hour session does not send forty emails.

## Alternatives considered

**Add PARKING and PARKED to `MissionState`.** Rejected: ADR-004 forbids it without
cause, and parking is a fact about the mount the telemetry already carries.

**Free-form retarget (any coordinates).** Rejected: a client never chooses where the mount
points (contract `ClientCommandType`). A catalogue id from a list the cloud computed keeps
that true.

**Captures without leaving OBSERVING.** Simpler for the agent, but the customer would not
see that a capture is running, and the existing PROCESSING handover (deliver before
COMPLETE, exactly once) would need a second path.

**A cloud-minted PARK at slot end.** Rejected for the reason in §2: the agent already
knows the deadline, and the cloud only needs to be able to end the session, not drive the
mount.

## Consequences

- Contract: `RETARGET` in `ClientCommandType` and `CommandType`, `RetargetPayload`,
  `RetargetRequest`, `GET /missions/{missionId}/targets` with `MissionTargetList` and
  `MissionTargetOption`; `Mission.currentTargetId`, `sessionEndsAt`, `retargetAllowedAt`;
  `MissionTelemetryUpdate.currentTargetId`, `retargetAllowedAt`, `captureAllowedAt`,
  `imageHealth`, `endPhase`; `MissionEndPhase`, `SessionEndReason`,
  `CloudSessionUpdate.endReason`, `MISSION_SESSION_ENDED`; `AgentStateDelta.currentTargetId`,
  `AgentCaptureReady.targetId`; six `ErrorCode`s and seven `CommandRejectionReason`s. All
  additive; `WebSocketProtocolVersion` stays "1". An agent that predates this refuses a
  RETARGET as malformed, which fails closed.
- Database: `CommandType.RETARGET`, `Mission.currentTargetId`, PROCESSING in the live
  index, `EmailNotificationKind.SESSION_SUMMARY`, and a marker so the session-ended message
  and the summary are written once.
- A customer who leaves the page does not end the session; the slot runs to its end and
  parks. This is the intended behaviour, and the reason the agent ends on its own clock.
- Longer sessions mean more captures to store; the cap of 50 bounds it.

## What this deliberately does not decide

- Refunds for a slot spent waiting for clouds (ADR-080 reports it; DV-111 decides it).
- Whether observers or Tonight spectators may see the visible-now list.
- Real-hardware sessions with nobody at the instrument: ADR-081, and off until approved.

## When this would be revisited

If the 10-minute dwell proves too long for short sessions (a 15-minute slot allows one
switch at most), or measured mount wear shows it is not needed.
