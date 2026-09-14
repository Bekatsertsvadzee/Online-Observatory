# ADR-018 — A customer starts their booked mission, and a slot nobody starts closes itself

- **Date:** 2026-09-14
- **Status:** APPROVED
- **Decided by:** project maintainer, in session (direction: customer-initiated start
  inside the booked window, and a sweep for no-shows)
- **Approved:** 2026-09-14, as written
- **Arises from:** issue #72; `docs/audits/2026-09-13-review.md` (P1, a paid booking
  has no implemented path into an observation)
- **Relates to:** `ADR-004` (state machine), `ADR-009` (command relay), `ADR-015`
  (booking model), DV-058 (sessions)

## Context

Settlement writes a booked mission in `SCHEDULED` (`features/payments/settle.ts`).
`POST /missions/{missionId}/start` refuses anything outside `LIVE_MISSION_STATES`, so it
refuses `SCHEDULED`. Nothing else in `apps/api` or `apps/realtime` writes a state that
moves a scheduled mission forward. A customer can pay for an observation that no code
path will ever run.

The agent already knows how a mission begins. `_execute_goto` in the supervisor starts
the runner when a `GOTO` arrives for a mission it does not yet hold, carrying the
session and the target's J2000 coordinates. `GOTO` is never client-initiated: the
contract says "the target comes from the booking". So what is missing is not a new
message but the cloud deciding, at the right moment, to mint that `GOTO`.

ADR-004 names the states and not the trigger. The maintainer chose the trigger: the
customer starts their own mission inside the window they bought.

## Decision

### 1. The existing start endpoint starts a scheduled mission

`POST /missions/{missionId}/start` keeps everything it does for a live mission. For a
`SCHEDULED` mission it additionally, **in one transaction**:

1. moves the mission `SCHEDULED → PREPARING` with a conditional update, so two starts
   cannot both win;
2. writes a `MissionEvent` in `PREPARING`, sourced `CLOUD`, and sets `startedAt`;
3. opens the session exactly as today, and notifies the agent of it;
4. mints a `GOTO` for the booked target under that session, `recenter: false`, and
   notifies the agent of it **after** the session, so the agent's validator already
   holds the owner the command names;
5. writes the audit row.

No contract change. The request and the `MissionSession` response are unchanged, and
every refusal below uses an `ErrorCode` that exists.

### 2. Only inside the booked window, and only when every existing check passes

Refused, and the mission stays `SCHEDULED`, when:

| Condition | Answer |
| --- | --- |
| Not the owner (operators keep their existing access) | `404 NOT_FOUND` |
| Before `slotStartAt` | `409 MISSION_NOT_ACTIVE` |
| At or after the slot's end | `409 MISSION_NOT_ACTIVE` |
| Observatory not `ONLINE` | `409 OBSERVATORY_OFFLINE` |
| Weather hold active | `409 WEATHER_HOLD` |
| Safety envelope missing or `maxAltitudeDegrees` unmeasured | `409 SAFETY_NOT_CONFIGURED` |
| The cloud's pointing pre-check refuses the target now (below the limit, near the Sun, masked) | `409 SAFETY_REFUSED` |
| Another mission is live at this observatory | `409 CONFLICT` — `Mission_active_per_observatory_unique` decides, not a query |

No early start. The slot before belongs to somebody else until its end, and the
exclusion constraint that sold both slots already made them adjacent, not overlapping.

A refused start changes nothing, so the customer may try again inside the window: a
target that was below the limit at the slot's first minute may have risen by its fifth.

### 3. A start the agent refuses does not hold the telescope

The agent validates the `GOTO` again and may refuse it. A `REJECTED` verdict on the
command that started a mission moves that mission to `FAILED` with the rejection's
`MissionFailureReason` (`SAFETY_REFUSED` when the agent gives a safety reason),
revokes the session, and writes a `CLOUD` event. Without this, a mission refused at the
observatory would sit in `PREPARING`, inside the live-mission index, and close the
telescope to every later customer until an operator cancelled it.

### 4. A slot nobody started closes at its end

A mission still `SCHEDULED` after its booked slot has ended moves to `CANCELLED` with
failure reason `SESSION_EXPIRED`, a `CLOUD` event, and an audit row naming it a
no-show. The booking stays `CONFIRMED`: the money was captured, and what happens to it
is the refund engine's decision (DV-111), not this record's.

The sweep runs in `apps/realtime`, on a timer beside the two it already runs, once a
minute. It is the only long-lived process, and an API that ran it on request would
leave missions `SCHEDULED` for as long as nobody asked. It commands nothing: a mission
that never started has nothing on the mount to stop.

## Alternatives considered

**A scheduler that starts the mission at slot start.** Declined by the maintainer. It
would slew a telescope with nobody watching, and a Phase 1 observation is one somebody
watches.

**An operator starts each mission.** Declined. It does not scale, and it cannot work for
an unattended partner observatory under ADR-013.

**A new endpoint, `POST /missions/{id}/begin`.** Rejected. Starting a scheduled mission
is opening its first session, and a second path to the same session would be two places
to keep the same checks in agreement.

**Resolving no-shows lazily, on the next read.** Rejected for §4's reason: a row nobody
reads would stay `SCHEDULED` indefinitely, which is the defect #72 records.

## Consequences

- `startMissionSession` gains a second branch, and every check in §2 is tested against
  PostgreSQL, including two simultaneous starts.
- The realtime store gains the start-refusal rule in §3 and the no-show sweep in §4.
- Issue #72's fourth criterion becomes buildable: authenticate → reserve → settle →
  start → capture with no direct database edit advancing a state. On the simulator only,
  with an envelope explicitly named fake inside that test.
- A customer who arrives ten minutes late gets the remaining twenty. The session still
  ends at the slot's end, as it does today.

## What this deliberately does not decide

- Refunds for a no-show, a refused start, or a weather-held slot (DV-111).
- Reminders or notifications before a slot opens.
- Starting early when the preceding slot is free.
- Flow B, queued capture (ADR-015 §4), which needs its own record.

## When this would be revisited

- When partner observatories need an attended start policy different from first-party.
- When Flow B introduces a mission nobody is present for.
