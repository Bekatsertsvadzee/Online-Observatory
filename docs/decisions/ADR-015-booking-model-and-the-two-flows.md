# ADR-015 — A customer books an instrument and a time, and there are two flows

- **Date:** 2026-09-10
- **Status:** PROPOSED
- **Decided by:** project maintainer, in session
- **Relates to:** `ADR-003` (Phase 1 scope boundary), `ADR-013` (partner observatories),
  `CLAUDE.md` § Product
- **Blocks:** the contract change that makes any partner node bookable

## Context

DV-120 registers a partner node and qualifies it. DV-121 reads the hours its owner
offered. **Neither makes a partner telescope bookable**, because nothing in the
booking surface can say which telescope a slot belongs to: `Slot` has no
`observatoryId`, `CreateBookingRequest` cannot name one, `GET /slots` takes only a
date, and both `slots.ts` and `reserve.ts` still resolve the observatory with
`findFirst` ordered by `createdAt`. `reserve.ts` has said so since DV-055: "Phase 1
is one observatory. When there is more than one this takes an id."

That is not a missing field. It is a missing product decision — does a customer buy
*a time* and get whichever instrument is free, or buy *an instrument*? — and it
decides the booking page, the contract and what a partner is selling.

## Decision

### 1. The customer books an instrument, and a time on that instrument

Slots are per-observatory. A customer chooses a telescope and then a time it is
free. They are not allocated an instrument by the system.

This is what a partner is selling. A person who lists their telescope is offering
*that* telescope, with its aperture, its sky and its horizon; a booking that could
be served by any free instrument would make the partner interchangeable with every
other, which is not the thing ADR-013 set out to enable.

### 2. Slot duration varies, and the duration decides which targets are offered

The maintainer named ten minutes and one hour. Both are **PROVISIONAL** — no
controlling document states session lengths, the Build Plan puts them on the
`/pricing` page, and pricing is not settled.

`generate.ts` today sells one length on purpose: "Selling a 15-minute slot and then
letting a customer choose M13 would be selling something we cannot deliver." That
reasoning is not repealed; it is honoured differently. **The duration the customer
booked filters the target list.** A short slot offers the Moon, the planets and
bright doubles; a long one opens the catalogue. A customer never sees a target the
slot cannot deliver, so the promise is kept by construction rather than by a
warning.

**Ten minutes is shorter than anything yet measured.** DV-052 derived fifteen
minutes for short-exposure targets, and a session also spends time on slew, plate
solve and centring before a single frame is kept. What fits in ten minutes is a
measurement nobody has taken. It is taken before a ten-minute slot is sold, not
assumed.

### 3. Flow A — Live Observation — is Phase 1, and it is what exists

The customer books an instrument and a time, watches the live view, and steers with
`NUDGE`: a discrete bounded step, checked against the safety envelope, with a
cumulative allowance so the target cannot be walked off frame. On-screen arrows and
keyboard arrows both map onto it.

**A held arrow key does not stream continuous motion.** `NudgePayload` says "One
discrete bounded step. Never a continuous slew," and that is deliberate: a
continuous command has no bounded end state, so a dropped connection mid-slew
leaves a mount moving with nobody watching. A UI that wants a held key sends
repeated discrete nudges and stops when the key is released.

### 4. Flow B — Queued Capture — is Milestone 2, and is recorded here so Phase 1 does not preclude it

A customer names a target and pays; whenever the instrument is next free and the
target is up, the observatory captures it and delivers the images. There is no live
session and the customer is not present.

**It is explicitly out of Phase 1.** `CLAUDE.md` defines Phase 1 as a live
observation somebody watches. Flow B needs a scheduler, a queue, a delivery step,
and a refund policy for the week when weather closes every window — none of which
exist. It gets its own decision record when it is taken up.

What this record commits to now is only that Phase 1's contract must not make
Flow B impossible: a booking must not be so tightly bound to "a customer is
watching right now" that an unattended capture cannot reuse the mission machinery.

## The consequence that is not obvious

**Variable duration breaks DV-055's exclusivity guarantee.**

```sql
CREATE UNIQUE INDEX "Booking_held_slot_unique"
  ON "Booking" ("observatoryId", "slotStartAt")
  WHERE "status" IN ('PENDING_PAYMENT', 'CONFIRMED');
```

The index is keyed on the **start instant**. With one fixed length that is
sufficient and elegant: every slot starts on the same stride, so an equal start is
the same slot and a different start cannot overlap. With mixed durations it is
silently wrong — a sixty-minute booking at 21:00 and a ten-minute booking at 21:20
have different start instants, so both inserts succeed and two customers hold one
telescope at the same time.

DV-055 was explicit that exclusivity lives in the index and nowhere else, precisely
so it cannot be quietly weakened by application code. Honouring that means
replacing the index rather than adding a check above it: a PostgreSQL exclusion
constraint over the booked interval, `EXCLUDE USING gist (observatoryId WITH =,
tstzrange(slotStartAt, slotStartAt + durationMinutes) WITH &&)`, which needs the
`btree_gist` extension.

**No variable-duration slot may be sold before that constraint exists**, and the
test that proves it is the one DV-055 already established: drop the constraint,
watch a named test double-book, restore it.

## What this record deliberately does not decide

- Prices, and which durations are actually offered
- How a customer chooses between instruments — a list, a map, a recommendation
- Whether a partner sets their own price
- Anything about Flow B's mechanics beyond not precluding it
- Whether the ten-minute slot survives the measurement in §2

## When this would be revisited

If the measurement in §2 shows that no catalogue target fits ten minutes once slew,
solve and centring are counted, then the short slot is not a product and §2's filter
has nothing to offer. That would not reopen §1 or §3.
