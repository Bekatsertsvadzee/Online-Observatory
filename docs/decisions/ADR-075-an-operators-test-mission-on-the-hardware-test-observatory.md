# ADR-075 — An Operator's Test Mission on the Hardware Test Observatory

- **Date:** 2026-10-27
- **Status:** APPROVED (maintainer's request of 2026-10-27, "continue with the next task";
  ADR-074 names this as the next piece of work)
- **Decided by:** project maintainer
- **Relates to:** ADR-074 (the hardware test observatory), ADR-004 (a booked mission is born
  SCHEDULED), ADR-015 (what is bookable), clients ADR-072 (quarter-hour lengths), DV-036

## Context

ADR-074 put the real telescope on its own observatory, which no customer can book. A full
mission needs a booking: `POST /missions/{id}/start` refuses a SCHEDULED mission that has
none, because the booking is what says when the time begins and ends. So the first real
end-to-end mission (DV-036) had no way in.

## Decision

1. **`POST /admin/observatories/{observatoryId}/test-mission`**, operator only, with a
   target and a length (15 to 240 minutes in quarter hours). It writes, in one transaction,
   a CONFIRMED booking for the calling operator at no price, starting this minute, and its
   SCHEDULED mission in the observatory's current mode, with the SCHEDULED event and an
   audit row (`MISSION_SCHEDULED`, `detail.testMission`).
2. **Only the hardware test observatory**, the one named by
   `DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID`, and only while it has no APPROVED node. Any
   other observatory, or this one once a customer could book it, answers 403. Customers'
   time is sold through `POST /bookings`; an operator does not take it here.
3. **Nothing else of a customer's booking.** No payment, no points, no email. The slot
   exclusion constraint still applies, so two test missions cannot overlap (409).
4. **Starting is unchanged.** The operator starts the mission with
   `POST /missions/{id}/start`, which applies the slot window, the safety envelope and the
   agent's checks exactly as for a customer. On a REAL observatory with MAX_ALT_SAFE
   unmeasured that refuses every slew, which is the intended state until RUNBOOK §5 is done.

## Consequences

- An attended operator can run the whole path, booking to capture, on the real telescope
  while the demo keeps selling simulated sessions.
- A test mission that ends unsuccessfully may grant the operator's own booking an
  entitlement (DV-111) like any booking; it is the operator's, at no price, and harmless.
- The endpoint goes with `DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID` when the demo ends.
