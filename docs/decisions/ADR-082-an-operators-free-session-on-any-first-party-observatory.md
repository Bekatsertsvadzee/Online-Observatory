# ADR-082 — An Operator's Free Session on Any First-Party Observatory

- **Date:** 2026-11-19
- **Status:** APPROVED (maintainer's request of 2026-11-19: "I need the admin profile with
  free telescope access, so whenever the platform starts it should open a session green,
  and I should be able to enter the observatory room")
- **Decided by:** project maintainer
- **Amends:** ADR-075 §2 (only the hardware test observatory)
- **Relates to:** ADR-074, ADR-079 (opening the room inside the slot starts the session),
  ADR-013 (partner observatories)

## Context

ADR-075 let an operator book free time only on the hardware test observatory, which no
customer can book, so that an operator never took time that is sold. The maintainer runs
the observatories and wants to open the telescope at any moment and go straight into
the room, on the demo and later on the real telescope, without paying and without
picking a target first.

## Decision

1. **Any first-party observatory**, as well as the hardware test one. A partner's
   observatory (ADR-013) is not ours to give away and still answers 403. The refusal of an
   observatory with an APPROVED node is dropped.
2. **A customer's booking still wins.** Nothing new guards it: the slot exclusion
   constraint refuses an overlapping booking with 409 SLOT_UNAVAILABLE, as it refuses two
   customers.
3. **The target is optional.** Left out, the brightest enabled target this observatory
   can observe that is above its own minimum altitude now, and inside the safety envelope
   once MAX_ALT_SAFE is measured, is chosen. None up: 409 SAFETY_REFUSED, nothing written.
   The start (`POST /missions/{id}/start`) still runs every check of its own.
4. **Opening twice lands in the same room.** When the operator already has a live free
   session on this observatory whose time has not ended, that session is answered as it
   stands and nothing is written. An unstarted one is still replaced (ADR-075 §4).

The endpoint keeps its path, `/admin/observatories/{id}/test-mission`, and its response.

## Consequences

- An operator's free session can hold time a customer would otherwise have booked. The
  website's "Open the telescope" asks for one hour and the operator can end it early.
- Every one is audited as `MISSION_SCHEDULED` with `detail.testMission`, so free time is
  counted apart from sold time.
