# ADR-081 — What Must Be True Before a Real Telescope Runs a Session Unattended

- **Date:** 2026-11-01
- **Status:** PROPOSED — and even once approved, **nothing in it is enabled** until every
  condition in §2 holds on the instrument. Until then real hardware runs only `ATTENDED`.
- **Decided by:** project maintainer (pending; direction given 2026-11-01, decision D3 of
  the booked-session spec)
- **Relates to:** ADR-013 (partner observatories), ADR-023 (queued capture), ADR-024 (the
  agent's unattended posture), ADR-018 (the customer starts their mission), ADR-079 (a
  booked session runs for its whole slot), ADR-080 (image health), `docs/ENGINEERING.md`
  "Hardware safety", `docs/SAFETY.md`, DV-034–DV-039, DV-124
- **Blocks:** any live booked session on first-party real hardware without an operator at
  the instrument

## Context

The owner wants booked sessions to run with nobody at the telescope. ADR-079 and ADR-080
build that, and it is proven on the simulator.

On real hardware the project already has three rules that answer "who is there":

- `docs/ENGINEERING.md`: real-hardware mode on a first-party observatory requires an
  explicit, attended operator action, and no unattended or background process may command
  the real mount or camera.
- ADR-023 allows exactly one first-party unattended case — a **queued capture** — while
  the node is `UNATTENDED_APPROVED` and the agent is armed, after DV-124, DV-037, DV-038,
  a number of attended real missions and a fitted sky sensor.
- ADR-024 defines how the agent knows: the `UNATTENDED` posture, armed locally from
  `ATTENDED`, latching to `DISARMED` on any fault, refusing the daylight override.

A booked live session with nobody at the instrument is none of these. The customer is on
the feed (as on an ADR-013 partner), but the instrument is first-party and its operator is
absent. This record says what that case needs, and that it stays off.

## Decision

### 1. The same mechanism, one more case

A live booked session on a first-party observatory may run with nobody at the instrument
only in ADR-024's `UNATTENDED` posture, armed locally at the observatory, never by the
cloud, and only while the cloud holds the node `UNATTENDED_APPROVED` under ADR-023 §3.
There is no separate approval and no separate posture: what ADR-023 qualifies for a queued
capture qualifies the instrument, and this record adds the conditions a live session
needs on top. Every ADR-024 rule applies unchanged — the daylight override is refused, the
arming dies with its process, the latch disarms on any fault and only a person re-arms it.

The customer starting the session by opening the page (ADR-079 §1) does not change who
may move the mount. A customer is not an operator, and their presence on the feed is not
attendance at the instrument.

### 2. What must be true, all of it, before it is armed

| Condition                                                                                                                                                                                      | Why                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ADR-023 §3's whole table: DV-124 qualification, DV-037 Park from every failure path, DV-038 evidence run, the minimum number of attended real missions                                         | the qualification already approved; this record does not weaken it                                                      |
| **`MAX_ALT_SAFE` measured** on this optical train and recorded in the envelope (RUNBOOK §5)                                                                                                    | an unmeasured envelope refuses every slew; it is never defaulted                                                        |
| **A horizon mask and forbidden sectors recorded** for the site, verified by a supervised sweep                                                                                                 | RETARGET (ADR-079) moves the mount across the sky with nobody watching where it goes                                    |
| **A physical rain sensor and a sky (cloud) sensor fitted**, reporting to the agent as `WeatherState` with `source: SENSOR`; stale readings are a weather hold and a latch trigger (ADR-024 §6) | rain is the fault an attended operator exists to catch; image analysis cannot see rain until the optics are already wet |
| **Forecast gating**: a session is not started, and an armed agent parks, when the site forecast (DV-066's source) shows precipitation probability or wind above limits for the slot            | the forecast sees weather arriving that neither sensor has yet                                                          |
| **Image-based cloud detection** (ADR-080 `CLOUDS`) active and proven on real frames                                                                                                            | a third, independent signal; it decides WAITING, never that it is safe to open                                          |
| A Park that has been seen to complete at the end of a real slot, commanded by the slot-end path of ADR-079 §2, on this mount                                                                   | the slot end is the most frequent unattended Park there will ever be                                                    |
| Sun-safe RETARGET proven on the real envelope: the cloud and agent both refuse a target in the Sun exclusion and daylight lock                                                                 | the Sun floors are code, but they have only been exercised on the simulator                                             |

The order of trust is the existing one: sensors and forecast can only close the
observatory; nothing opens it but a local arming by a person who looked.

### 3. It stays off

Today none of §2's hardware exists: no rain or sky sensor is fitted, `MAX_ALT_SAFE` is
unmeasured, DV-037 and DV-038 have not run. So:

- `load_config` still refuses `DRIVER_MODE=REAL` without `ATTENDED`. Unchanged.
- `arm-unattended` still refuses on real drivers until a sky sensor is fitted (ADR-024,
  correction of 2026-09-22). This record extends that refusal: it also requires a rain
  sensor and a measured envelope.
- The cloud offers no first-party real slot as unattended, and the operator console shows
  the reason.
- Everything in ADR-079 and ADR-080 is built and tested on `SimMount` and `SimCamera`,
  where the simulator may be armed exactly as ADR-024 allows today.

### 4. The amendment it would make

On approval, `docs/ENGINEERING.md` "Hardware safety" gains a sentence beside ADR-023's
queued-capture case:

> A **live booked session** on a first-party observatory may run with nobody at the
> instrument only under the same `UNATTENDED_APPROVED` approval and local arming, and only
> while a rain sensor and a sky sensor report fresh, the forecast permits it, image-based
> cloud detection is active, `MAX_ALT_SAFE` is measured and the horizon mask is recorded
> (ADR-081).

The existing sentences are not deleted. The resting state for everything not both approved
and armed is still "no unattended process commands the real mount".

## Alternatives considered

**Let the customer's presence count as attendance.** Rejected: the customer cannot see
rain, cannot reach the mount, and is not who ENGINEERING.md means by an operator.

**Image-based cloud detection instead of a sky sensor.** Rejected as the only signal: it
cannot see rain, and a dark frame is equally clear sky with a bad exposure and a wet
corrector plate. It is kept as a third signal.

**A separate approval for live sessions.** Rejected: two qualifications for one instrument
would drift apart. One approval, plus the extra conditions in §2.

## Consequences

- No code path is enabled by this record. It adds requirements to arming and a sentence to
  ENGINEERING.md when approved.
- Hardware to buy: a rain sensor and a sky sensor, chosen and given a staleness limit by
  measurement (ADR-023's open item, now two devices).
- Agent: `arm-unattended` checks the extra conditions; forecast and rain readings become
  latch triggers.
- Cloud: the forecast gate before `POST /missions/{id}/start` on an unattended node; the
  console shows which condition is missing.
- A missing sensor reading during a session parks it and disarms the node; DV-111 already
  needs a rule for the bookings that strands (ADR-024 Consequences).

## What this deliberately does not decide

- Which sensors, their staleness limits, and the forecast thresholds — measured, not
  chosen here.
- Whether partner nodes (ADR-013) need the rain sensor too. They need a sky sensor
  (ADR-024 §6); rain is proposed for them by the same argument and left to the maintainer.

## When this would be revisited

When the sensors are fitted and DV-037's drills have run, with evidence; or if an attended
real session shows a fault none of §2's signals would have caught.
