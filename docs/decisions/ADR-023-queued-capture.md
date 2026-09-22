# ADR-023 — Queued Capture, and what commands a telescope when nobody is watching

- **Date:** 2026-09-21
- **Revised:** 2026-09-22 — the agent enforces unattended operation itself; pre-emption
  expressed in ADR-004's states; a scheduler role of its own; weather sensing added to the
  qualification; a delivery threshold for §5. Same day: the agent's posture is ADR-024's,
  and `NUDGE` is removed by the scheduler's role, not by the posture
- **Status:** APPROVED — nothing is built from it before DV-038 and a fitted sky sensor
- **Decided by:** project maintainer
- **Approved:** 2026-09-22, with the answers recorded at the end
- **Relates to:** `ADR-015` (booking model and the two flows), `ADR-013` (partner
  observatories), `ADR-003` (Phase 1 scope boundary), `ADR-004` (mission state machine),
  `ADR-010` (agent local state store), `ADR-024` (the agent's unattended posture),
  `ADR-012` (capture storage and upload), `ADR-022`
  (subscriptions), issue #97
- **Blocks:** any Flow B implementation, and the `CLAUDE.md` amendment it needs
- **Blocked by:** DV-038, the attended evidence run, and a fitted sky sensor (§3). Nothing
  here is built before both.

## Context

ADR-015 §4 named Flow B — Queued Capture — and deliberately decided nothing about it
beyond not precluding it. The maintainer placed it in Milestone 2 on 2026-09-15. Issue #97
is what it owes before any code.

The customer names a target and pays. Whenever the instrument is next free and the target
is up, the observatory captures it and delivers the images to their Collection. There is
no live session and **the customer is not present**.

That last clause is the whole problem. Every safety rule Darkview has was written on the
assumption that a human being is watching a telescope move, and one of them says so
outright:

> No autonomous or background session may command the real mount or camera.
> — `CLAUDE.md`, Hardware safety

Flow B is, by construction, an autonomous session commanding a real mount. This record
cannot be implemented without amending that sentence, and amending it is the maintainer's
decision, not an implementation choice.

## The conflict this record exists to resolve

There are two rules, and Flow B sits between them.

**The first-party rule** is absolute: real-hardware mode on a first-party observatory
requires an explicit, attended operator action outside the normal test workflow. It exists
because nothing had ever been measured. It is the correct resting state for an instrument
whose optical train has not been characterised.

The agent enforces that rule itself, not only the cloud. `load_config` refuses to start
with `DARKVIEW_AGENT_DRIVER_MODE=REAL` unless `DARKVIEW_AGENT_ATTENDED` is also set, and
refuses a config file that carries either (`agent/darkview_agent/config.py`). The same
attended flag is what lets an operator lift the daylight lock
(`CommandValidator.operator_override`): the cloud's `issuedByOperatorId` is a necessary
condition, never a sufficient one.

**ADR-013 already broke the assumption once**, and did it well. A partner node may operate
unattended while `APPROVED`, and approval is a *procedure*: a measured envelope,
sky-verified coordinates, a recorded horizon mask, a supervised first light, and Park
proven on that hardware. It returns to refusing everything the moment any of those stops
holding.

So the project has already decided that "attended" can be replaced by "qualified", for a
machine somebody else owns. The question this record answers is whether the same
substitution is allowed for a first-party machine, under what conditions, and — because
the attended flag is local — where that substitution is enforced.

## Decision

### 1. Queued Capture is a mission, and the agent knows when nobody is there

A queued request produces a `Mission` and runs the ADR-004 state machine unchanged.
It slews, solves, centres, observes, captures, processes and completes, and every
transition writes a `MissionEvent` exactly as a live mission does.

**The agent is told it is unattended, and it is told locally.** Running the real mount
with nobody present leaves only two possibilities today, and both are wrong:

- Start the agent with `DARKVIEW_AGENT_ATTENDED` set while nobody is there. The flag
  becomes false, and it also arms the daylight-lock override that exists only for an
  operator standing at the instrument.
- Keep the approval only in a cloud row and let the agent run as it does now. The agent
  can then no longer check the one fact that decides whether it may move at all, and a
  compromised or buggy cloud could drive the mount with nobody present. That is exactly
  the trust the double-validation design withholds.

So the agent gains a third operating posture beside simulated and attended:
**unattended**, defined once for partner and first-party nodes alike in ADR-024. It
differs from attended in what it *removes*, never in what it adds: `operator_override` is
always false, so the daylight lock cannot be lifted, and every other rule — envelope,
horizon mask, Sun avoidance, session ownership, expiry, duplicate rejection, weather hold,
emergency Park — applies unchanged.

**`NUDGE` is removed by who owns the session, not by the posture.** A queued mission's
session owner is the scheduler, whose role has no `NUDGE` (Consequences). The posture
keeps `NUDGE`, because on an unattended partner node the live customer is present on the
feed (ADR-024 §1).

The unattended posture is armed by a local act from an attended agent, for that process
only, and never by an environment variable or the cloud (ADR-024 §2). The cloud may disarm
it and never arm it (ADR-024 §3). Either side alone is not enough, which is the same shape
as `DRIVER_MODE` and `ATTENDED` today.

This is a reversal of the earlier draft, which said the agent should stay ignorant. The
agent is kept ignorant of *observers* (ADR-007) because an observer cannot change what the
mount may do. Whether a person is present *does* change what the mount may do, and the
agent already knows it through the attended flag. The honest answer is a third value, not
a flag that lies.

### 2. Live bookings always win, and a queued mission never holds the instrument

A queued request is **not** a booking and never occupies a slot. It runs only in the gaps.

- The scheduler considers an instrument only when it has no `CONFIRMED` booking overlapping
  the window it wants, **plus a margin that covers stopping capture and Parking** before
  the next live slot starts — not only the slew, solve and centre at the beginning.
- A queued mission is **pre-emptible**. When a live booking is confirmed for a window a
  queued mission is running in, the queued mission is stopped at the next safe boundary,
  Parks, and ends.

**The request returns to the queue; the mission does not.** ADR-004 has no transition
back to `SCHEDULED`, and every path out of a failure or hold ends at Park. A pre-empted
mission ends in `CANCELLED` with a new `MissionFailureReason`, `PREEMPTED`. The captures
it already made stay attached to it. The queued request stays open and produces a new
`Mission` the next time the scheduler finds a gap. `PREEMPTED` is a contract change; no
new mission state is added.

**Session ownership moves only through Park.** One active session owner at a time: the
queued session is closed when its mission reaches `CANCELLED` and the mount has reported
Parked, and the live booking's session opens after that. The margin above exists so that
this handover finishes before the live slot starts, not during it.

Pre-emption is a normal outcome, not a failure. A queued request that is pre-empted six
times and completes on the seventh delivered exactly what it promised.

This is what makes Flow B sellable without capacity planning: it consumes only time
nothing else wanted.

### 3. Unattended first-party operation requires a qualification, enforced in two places

**Proposed:** amend the first-party rule to match ADR-013's shape rather than to remove it.
A first-party instrument may run a queued mission unattended only while **all** of the
following hold:

| Condition | Where it comes from |
| --- | --- |
| The DV-124 qualification procedure passed on this instrument — the same procedure ADR-013 applies to partners: measured `MAX_ALT_SAFE`, sky-verified coordinates, horizon mask, supervised first light, Park proven commanded and on link loss | DV-034, DV-035, DV-036, DV-124 |
| Park proven from every failure path | DV-037 |
| An accumulated evidence run with no unexplained fault | DV-038 |
| A minimum number of attended real missions, the number set after DV-037's failure drills | maintainer, 2026-09-22 |
| **A sky sensor fitted, and its readings reaching the agent fresh** | new, this record |
| An operator has armed unattended operation, as a named act at the observatory | new, this record |
| No unacknowledged `HARDWARE_ERROR` since it was armed | new, this record |

**Weather is the fault an attended operator exists to catch.** Phase 1 has no sky sensor:
an operator at a window is the only thing that can declare the weather unsafe (DV-039).
With nobody at the window, nothing notices rain or cloud building mid-run. Unattended
operation therefore requires a fitted sensor whose readings arrive at the agent as
`WeatherState` with `source: SENSOR`. **Stale sensor data is a weather hold**: the agent
treats a missed reading as unsafe, Parks, and refuses everything but `PARK` and `ABORT`,
exactly as it does for an operator's hold today. Which sensor, and what staleness means in
seconds, is DV-035's kind of measurement, not this record's.

**The cloud holds the approval; the agent holds the arming.** The cloud row records who
approved the node, when, and against which evidence, and the scheduler reads it before
creating any queued mission. The agent's arming is persisted in the ADR-010 local state
store, written only by a local operator action on the observatory machine, and it is what
the agent checks on every command. Neither can arm the other.

**It fails closed and it latches, on the agent.** Any `HARDWARE_ERROR`, any failed Park,
any loss of sky-sensor data during an unattended mission disarms the local record. The
agent does not re-arm on its own, on reconnect, or on a cloud message: an operator re-arms
it, having looked. The cloud mirrors the disarm so the scheduler stops creating missions,
but the agent's latch is the one that holds after the link is gone.

**Nothing here touches attended operation.** A live mission with an operator present is
unchanged, and remains the only way a first-party instrument runs before this
qualification completes.

### 4. Delivery is the existing capture path, and the customer is told

Captures are written by the agent through the ADR-012 upload grant and recorded exactly as
a live mission's are. The Collection needs no new concept: a queued capture is a `Capture`
with a `Mission` behind it.

What is new is that nobody saw it happen, so the notification is the delivery.
`DV-064`'s notification surface carries it: one message when the request completes, naming
the target and linking the Collection. A partially delivered request — pre-empted, or
weather-closed with some frames kept — is delivered as what it is, with the frames it got.

**The customer is never shown a queued capture as a live one.** A `Capture` records the
mission that produced it, and a UI that cannot tell the difference is a UI bug, not a
product feature. Nothing in Phase 1's brand rules permits presenting an unattended capture
as a live observation.

### 5. Weather refunds run on a window count, not a calendar

A queued request has a **lifetime** — a number of nights, set when it is sold — and it
refunds if that lifetime passes without a delivery.

- **A delivery has a floor.** A request counts as delivered only when its captures meet a
  minimum — total integration time, and a capture that plate-solved on the target — set
  per target from DV-035's measurements. A single frame through cloud is not a delivery.
- **Expired below the floor: full refund**, automatic, on DV-111's engine and its existing
  money-return rules. Frames taken below the floor are still delivered to the Collection;
  they do not cost the customer the refund.
- **Delivered at or above the floor: no refund.** The customer may re-queue.
- **A refund returns what was spent.** If the request was bought with subscription
  minutes, minutes come back, not money — the rule ADR-022 §7 already establishes for a
  credit-paid booking.

The lifetime is what makes this decidable without predicting weather. A request that
cannot be filled in its lifetime is a request the sky refused, and the customer is not
charged for the sky.

### 6. `CLAUDE.md` and `docs/ENGINEERING.md` are amended, in the commit that approves this record

The Hardware safety section gains a third case beside first-party and partner:

> A **queued capture** on a first-party observatory may run unattended only while the node
> is `UNATTENDED_APPROVED` under ADR-023 **and** the agent's local unattended arming is
> set. Approval requires the DV-124 qualification, DV-037 and DV-038, and a fitted sky
> sensor; arming is a named operator act at the observatory. The agent enforces it
> locally, refuses the daylight override while unattended, and disarms itself
> on any hardware error or loss of sky data until an operator re-arms it.

The existing sentence — "No autonomous or background session may command the real mount or
camera" — is **not** deleted. It is qualified, in the same way ADR-013 qualified the
attended-operator rule, and it remains the resting state for everything that is not both
approved and armed.

## Why this route

- **It reuses the one qualification pattern the project has already approved.** ADR-013
  decided that a procedure can replace a person, and DV-124 is that procedure run on the
  first-party instrument. Gating on DV-124 rather than a parallel list means one safety
  story, not two.
- **The rule is enforced where the mount is.** An approval that lives only in the cloud is
  an approval the agent has to take on trust, and the agent exists to withhold that trust.
  A local arming that latches off is the unattended equivalent of the attended flag.
- **Pre-emption removes the scheduling argument entirely.** A queued mission that yields to
  every live booking cannot starve the product that pays for the telescope, so the
  scheduler needs no fairness policy, no priority tiers and no capacity model.
- **The refund rule needs no weather model.** A lifetime in nights and a delivery floor are
  numbers the customer understands and the system can evaluate exactly.

## Alternatives considered

- **Attended queued capture** — an operator present for every queued run. Honest, and it
  needs no amendment to anything. Rejected as a product: the value of Flow B is that it
  fills the hours nobody is awake for, and an operator who must be present for each one has
  simply been sold a worse live session.
- **Partner-only Flow B** — queue only onto ADR-013 nodes, which may already run
  unattended. Tempting, and it needs no `CLAUDE.md` change at all. Rejected because it
  makes the first-party instrument the *least* capable node on the network, and because
  DV-124 already establishes that Darkview does not ask a partner to do what it has not
  done itself.
- **Keep the agent ignorant, with the approval only in the cloud** — the earlier draft of
  this record. Rejected: it either sets the attended flag with nobody present, or asks the
  agent to trust a cloud claim about whether it may move at all (§1).
- **A queued request holds a real slot** — sell it as a booking nobody attends. Rejected:
  it competes with live bookings for exactly the inventory that is worth the most, and it
  reintroduces every capacity question §2 removes.
- **Refund on a weather model** — predict openable windows and refund when the prediction
  fails. Rejected as unfalsifiable to the customer and expensive to build.

## Consequences

- **Nothing is built before DV-038, and nothing runs without a sky sensor.** The
  qualification this depends on is the attended backlog, and that backlog is blocked on
  hardware that does not exist yet. The sensor is a hardware purchase this record adds.
- **The agent gains an unattended posture**, specified in ADR-024: a local arming record
  in the ADR-010 store, a local operator command that writes it, the removal of
  `operator_override` under it, and a latch that disarms on hardware error, failed Park or,
  under this record, stale sky data.
- **The scheduler is a principal of its own.** `UserRole` today is `USER` and `OPERATOR`;
  the scheduler gets a third role, `SCHEDULER`, with the minimal command set a queued
  mission needs and no `NUDGE`, and a seeded system user whose id fills `userId` on its
  `CommandEnvelope`s. It is not an `OPERATOR`, because the operator role carries the
  daylight override and the scheduler must never have it. This is a contract change.
- **`MissionFailureReason` gains `PREEMPTED`.** No mission state is added; ADR-004 stands.
- **New state exists on an observatory in the cloud:** an unattended-approval status, who
  approved it, when, against which evidence, and the mirrored arming state. One row,
  operator-written.
- **The scheduler is a new always-on component**, and it is the first thing in Darkview
  that *initiates* a mission without a human act. It belongs beside the DV-111 and ADR-022
  sweeps, in the realtime service, not in a serverless function.
- **The contract gains a queued-request surface** — create, list, cancel, and the states a
  request moves through. It is a contract change, made here and released, per the
  repository boundary rule.
- **Operator work grows.** Re-arming after a hardware error is now a gate on revenue, not
  just hygiene, and it is done at the observatory.
- **The target filter of ADR-015 §2 applies differently.** A queued request is not bounded
  by a slot length, so the catalogue it may choose from is wider — but DV-035 still decides
  what a capture actually costs, and both the queue's per-request time budget and §5's
  delivery floor come from that measurement, not from this record.

## What this record deliberately does not decide

- **Price, and whether a queued request is sold for money, minutes or both.**
- **The lifetime in nights.** §5 needs a number; the number is a product decision and
  wants at least one season of real weather data at the site.
- **The delivery floor per target**, beyond its shape in §5. It comes from DV-035.
- **Which sky sensor, and its staleness limit.** Measured, not chosen here.
- **How many queued requests one customer may hold at once**, and whether that scales with
  a subscription tier.
- **Queue ordering between two customers** whose requests are both fillable tonight.
  First-in is the obvious default and is not obviously correct.
- **Whether partner nodes accept queued requests**, and how revenue share works if they do
  — ADR-013 already lists revenue share as open.
- **Whether a queued capture may enter a public gallery.** ADR-013 lists the same question
  for partner captures; they should be answered together.

## Answers, 2026-09-22

The maintainer approved this record with these answers to its open questions.

1. **The §3 substitution is accepted** on ADR-024's terms: the agent enforces unattended
   operation locally, and the cloud can disarm it but never arm it.
2. **DV-038 is necessary but not sufficient.** Unattended first-party operation also waits
   for a minimum number of attended real missions; the number is set after DV-037's
   failure drills. §3's table carries it.
3. **The §6 wording is accepted.** The original sentence stays; the amendment qualifies it.
4. **Re-arming happens at the observatory**, as ADR-024 §2 and §4 specify.
5. **The lifetime in nights is deferred** to at least one season of weather data at the
   site. §5 cannot be sold until it is set.

## When this would be revisited

If DV-037's failure drills or DV-038's evidence run show any fault mode that a present
operator would catch and an unattended node would not, §3 is wrong as written and the
condition table needs that fault in it. Weather was the first such fault, and this record
now names it; the drills are expected to find others.
