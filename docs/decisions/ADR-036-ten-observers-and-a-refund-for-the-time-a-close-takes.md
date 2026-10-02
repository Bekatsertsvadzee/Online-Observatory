# ADR-036 — Ten Observers, and a Refund for the Time a Close Takes

- **Date:** 2026-10-02
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Amends:** `ADR-007-observer-pack.md`, rule 3 (five observers) and its "Why these
  limits"; adds a rule ADR-007 did not have.

## Context

Phase 4 slice 4 (`docs/plan/phase-4/04-sharing.md`) gave the session owner the control
to open and close their session to observers. Tracing `setMissionObservation` in
`darkview-platform` showed that closing marks every attached seat `LEFT`, and a closed
session refuses `joinMissionAsObserver`. An observer who paid for an Observer Pack seat
loses the rest of the session, and neither ADR-007 nor the platform gives anything back.

The maintainer was asked, and decided two things on 2026-10-02.

## Decision

1. **Ten observers, not five.** ADR-007 rule 3 now reads: _at most ten observers per
   session, in addition to the controller. A hard cap, enforced server-side._ Everything
   else in ADR-007 stands: one controller, observers never command, view only, opt-in
   per session.
2. **A close refunds the time it takes.** When the owner closes a session to observers,
   every observer whose seat was paid for is refunded the share of their price that
   matches the time they lose:

   `refund = priceMinor × (expiresAt − closedAt) ÷ (expiresAt − paidAt)`

   where `paidAt` is when the seat's payment settled and `expiresAt` is the session's
   end. Rounded up to the whole tetri, never more than was paid. It is automatic: the
   observer does not ask for it.

An observer who leaves on their own is not refunded. A seat the owner never closed runs
to the end of the session and is not refunded.

## Why

- **Ten still fits the architecture.** ADR-007 chose five so the existing realtime
  service could fan the live view out to a handful of WebSocket clients without a media
  server. Ten is still a handful from that one service. It is a bigger fan-out than was
  planned, so it is to be measured on the observatory's uplink when the hardware
  arrives. If ten does not hold, the cap comes down by another record. It does not open
  the door to a media server.
- **The refund follows what was bought.** A seat is a flat price for the rest of a live
  session from the moment it is paid. Closing takes back the minutes still to come, so
  those minutes are what is returned. The owner's consent stays absolute (ADR-007
  rule 5): they can close at any time, and the observers do not pay for it.

## Consequences

- **The contract changes in `darkview-platform`:** `Mission.observerCapacity` goes to
  `maximum: 10` and `default: 10`. The refund needs a field that records what was given
  back. Requested in `docs/platform-requests/observer-capacity-and-close-refund.md`.
- **The database changes there:** the `observerCapacity` CHECK in
  `20260907170000_dv100_observer_seats` allows 10, by a new migration, and
  `MAX_OBSERVER_CAPACITY` follows.
- **Refunds are partial for the first time.** DV-111's refund engine returns a payment
  whole, and only in sandbox. A partial refund is new to it. Until a live provider's
  refund API is integrated, a refund that cannot be issued is recorded as owed, exactly
  as DV-111 records a lost slot's refund, and never shown to anyone as paid.
- **The clients promise nothing until the platform does it.** The close confirmation says
  that anyone watching is removed. It adds that they are refunded for the time they lose
  only after the platform change merges, and slice 5's watch page tells the observer.
- **Safety is unaffected.** ADR-007's safety consequence stands word for word.
