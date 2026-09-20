# ADR-023 — Queued Capture, and what commands a telescope when nobody is watching

- **Date:** 2026-09-21
- **Status:** PROPOSED
- **Decided by:** not yet decided — this record is a draft for the maintainer
- **Relates to:** `ADR-015` (booking model and the two flows), `ADR-013` (partner
  observatories), `ADR-003` (Phase 1 scope boundary), `ADR-004` (mission state machine),
  `ADR-012` (capture storage and upload), `ADR-022` (subscriptions), issue #97
- **Blocks:** any Flow B implementation, and the `CLAUDE.md` amendment it needs
- **Blocked by:** DV-036, the first real mission. Nothing here is built before it.

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

**ADR-013 already broke the assumption once**, and did it well. A partner node may operate
unattended while `APPROVED`, and approval is a *procedure*: a measured envelope,
sky-verified coordinates, a recorded horizon mask, a supervised first light, and Park
proven on that hardware. It returns to refusing everything the moment any of those stops
holding.

So the project has already decided that "attended" can be replaced by "qualified", for a
machine somebody else owns. The question this record answers is whether the same
substitution is allowed for a first-party machine, and under what conditions.

## Decision

### 1. Queued Capture is a mission, not a new machine

A queued request produces a `Mission` and runs the ADR-004 state machine unchanged.
It slews, solves, centres, observes, captures, processes and completes, and every
transition writes a `MissionEvent` exactly as a live mission does.

Nothing about the agent changes. The agent does not learn that nobody is watching, for the
same reason it never learns an observer exists (ADR-007 and `docs/architecture.md` §7): a
fact the agent does not know cannot affect mount safety, command validation or session
ownership.

**What differs is who owns the session.** A live mission's session owner is a customer. A
queued mission's session owner is the scheduler, acting as a system principal with an
`OPERATOR`-equivalent role and no `NUDGE` capability at all. Flow B has no steering, so the
one command that exists to move a telescope on a human's judgement is simply absent from
its command set.

### 2. Live bookings always win, and a queued mission never holds the instrument

A queued request is **not** a booking and never occupies a slot. It runs only in the gaps.

- The scheduler considers an instrument only when it has no `CONFIRMED` booking overlapping
  the window it wants, plus a margin for slew, solve, centre and Park.
- A queued mission is **pre-emptible**. If a live booking is confirmed for a window a
  queued mission is running in, the queued mission is stopped at the next safe boundary,
  Parks, and returns to the queue with whatever it had already captured kept.
- Pre-emption is a normal outcome, not a failure. A queued request that is pre-empted six
  times and completes on the seventh delivered exactly what it promised.

This is what makes Flow B sellable without capacity planning: it consumes only time
nothing else wanted.

### 3. Unattended first-party operation requires a qualification, not a promise

**Proposed:** amend the first-party rule to match ADR-013's shape rather than to remove it.
A first-party instrument may run a queued mission unattended only while **all** of the
following hold, each verifiable from a database row:

| Condition | Where it comes from |
| --- | --- |
| `MAX_ALT_SAFE` measured on the assembled optical train | DV-034 |
| Horizon mask surveyed at the installation site | ADR-005, DV-034 |
| Sky-verified coordinates | DV-034 |
| Camera first light and optical train verified | DV-035 |
| A supervised first real mission completed | DV-036 |
| Park proven from every failure path | DV-037 |
| An accumulated evidence run with no unexplained fault | DV-038 |
| An operator has switched the node to unattended, as a named act | new, this record |
| No unacknowledged `HARDWARE_ERROR` since that switch | new, this record |

The final two are the ones that do not exist yet. The rest is the attended backlog, which
is why **this record cannot be implemented before DV-038** — the qualification it depends
on is the qualification that has not been run.

**It fails closed and it latches.** Any condition ceasing to hold returns the node to
refusing every unattended mission, and it does not return on its own: an operator switches
it back, having looked. A `HARDWARE_ERROR` on a queued mission suspends unattended
operation for that instrument until acknowledged.

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
refunds if that lifetime passes without a completed capture.

- **Expired unfilled: full refund**, automatic, on DV-111's engine and its existing
  money-return rules.
- **Partially delivered: no refund.** Frames were delivered; the request completed less
  than it hoped, not nothing. The customer may re-queue.
- **A refund returns what was spent.** If the request was bought with subscription
  minutes, minutes come back, not money — the rule ADR-022 §7 already establishes.

The lifetime is what makes this decidable without predicting weather. A request that
cannot be filled in its lifetime is a request the sky refused, and the customer is not
charged for the sky.

### 6. `CLAUDE.md` is amended, in the commit that approves this record

The Hardware safety section gains a third case beside first-party and partner:

> A **queued capture** on a first-party observatory may run unattended only while the node
> is `UNATTENDED_APPROVED` under ADR-023, which requires the full DV-034 to DV-038
> qualification, an operator's named switch, and no unacknowledged hardware error. It
> returns to refusing everything the moment any of those stops holding.

The existing sentence — "No autonomous or background session may command the real mount or
camera" — is **not** deleted. It is qualified, in the same way ADR-013 qualified the
attended-operator rule, and it remains the resting state for everything that is not
`UNATTENDED_APPROVED`.

## Why this route

- **It reuses the one qualification pattern the project has already approved.** ADR-013
  decided that a procedure can replace a person. Inventing a second, different answer for
  first-party nodes would mean maintaining two safety stories.
- **Pre-emption removes the scheduling argument entirely.** A queued mission that yields to
  every live booking cannot starve the product that pays for the telescope, so the
  scheduler needs no fairness policy, no priority tiers and no capacity model.
- **The refund rule needs no weather model.** A lifetime in nights is a number the customer
  understands and the system can evaluate exactly.
- **The agent stays ignorant.** Every alternative that tells the agent "this is unattended"
  creates a flag that can be wrong, and a flag that can be wrong on a mount is the thing
  the whole double-validation design exists to avoid.

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
- **A queued request holds a real slot** — sell it as a booking nobody attends. Rejected:
  it competes with live bookings for exactly the inventory that is worth the most, and it
  reintroduces every capacity question §2 removes.
- **Refund on a weather model** — predict openable windows and refund when the prediction
  fails. Rejected as unfalsifiable to the customer and expensive to build.

## Consequences

- **Nothing is built before DV-038.** The qualification this depends on is the attended
  backlog, and that backlog is blocked on hardware that does not exist yet.
- **New state exists on an observatory:** an unattended-approval status, who switched it,
  when, and the acknowledgement state of the last hardware error. One row, operator-written.
- **The scheduler is a new always-on component**, and it is the first thing in Darkview
  that *initiates* a mission without a human act. It belongs beside the DV-111 and ADR-022
  sweeps, in the realtime service, not in a serverless function.
- **The contract gains a queued-request surface** — create, list, cancel, and the states a
  request moves through. It is a contract change, made here and released, per the
  repository boundary rule.
- **Operator work grows.** Acknowledging a hardware error is now a gate on revenue, not
  just hygiene.
- **The target filter of ADR-015 §2 applies differently.** A queued request is not bounded
  by a slot length, so the catalogue it may choose from is wider — but DV-035 still decides
  what a capture actually costs, and the queue's per-request time budget comes from that
  measurement, not from this record.

## What this record deliberately does not decide

- **Price, and whether a queued request is sold for money, minutes or both.**
- **The lifetime in nights.** §5 needs a number; the number is a product decision and
  wants at least one season of real weather data at the site.
- **How many queued requests one customer may hold at once**, and whether that scales with
  a subscription tier.
- **Queue ordering between two customers** whose requests are both fillable tonight.
  First-in is the obvious default and is not obviously correct.
- **Whether partner nodes accept queued requests**, and how revenue share works if they do
  — ADR-013 already lists revenue share as open.
- **Whether a queued capture may enter a public gallery.** ADR-013 lists the same question
  for partner captures; they should be answered together.

## Open questions for the maintainer

These block approval, not implementation — the record cannot be approved as written until
they are answered.

1. **Is the §3 substitution acceptable at all** — may a procedure replace an attended
   operator on a *first-party* instrument, as it already may on a partner one?
2. **Is DV-038 the right gate**, or should unattended first-party operation wait for a
   longer evidence period than the one DV-038 defines?
3. **Does the §6 amendment wording preserve what the original sentence was protecting?**
   It is the maintainer's sentence and the maintainer's call.
4. **Lifetime in nights** — a number, or a decision to defer it to measurement.
5. **Money or minutes** for §5's refund, if a queued request can be bought with either.

## When this would be revisited

If DV-037's failure drills or DV-038's evidence run show any fault mode that a present
operator would catch and an unattended node would not, §3 is wrong as written and the
condition table needs that fault in it. That is the finding this record most expects and
most wants.
