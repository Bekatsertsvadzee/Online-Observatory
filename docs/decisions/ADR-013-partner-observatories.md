# ADR-013 — Partner observatories, and what "attended" means when nobody is there

- **Date:** 2026-09-09
- **Status:** PROPOSED
- **Decided by:** *pending — project maintainer*
- **Relates to:** `ADR-003` (Phase 1 scope boundary), `ADR-005` (installation site),
  `CLAUDE.md` § Hardware safety
- **Blocks:** any partner-facing onboarding, and the agent installer

## Context

Darkview Phase 1 operates one telescope, in Tbilisi, that Darkview owns. The
maintainer wants a second thing: a telescope **somebody else owns** joining the
network by installing the Observatory Agent on their own mini-PC or laptop — no
Darkview hardware, no dongle, no port forwarding — and being available to
customers during hours the owner chooses, including while the owner is away.

Three facts make this less of a leap than it sounds.

**The agent is already software-only and already outbound.** It is Python, it
dials out over an authenticated WSS, it accepts no inbound connection, and it
carries exactly one credential: a device token the cloud issues, scopes to one
observatory, and can revoke in a single row. A partner behind a domestic router
needs no firewall change and no static address.

**The mount interface is already network-shaped.** `CLAUDE.md` chose ASCOM Alpaca
over in-process COM so the mount would be "network-shaped, mockable and testable".
The side effect is that any ASCOM-capable mount can speak to the agent.

**The data model already anticipates partners.** `ObservatoryNetworkNode` carries
`ownerId`, `kind: FIRST_PARTY | PARTNER`, `approvalStatus: DRAFT | UNDER_REVIEW |
APPROVED`, `capabilities` and `approvedAt`; `NetworkAvailabilityWindow` carries a
weekday, a start minute, an end minute and an `enabled` flag. Both tables exist and
**no code reads either one.**

What does not exist is the answer to the question this feature actually asks.

## The conflict this record exists to resolve

`CLAUDE.md` § Hardware safety says:

> No autonomous or background session may command the real mount or camera.
> Real-hardware mode requires an explicit, attended operator action outside the
> normal test workflow.

A partner on holiday is unattended. That is the point of the feature, and it
contradicts the rule the entire hardware-safety posture rests on. `CLAUDE.md`
forbids resolving a conflict like this silently, and requires a dated record
before it may be outranked.

There is a second, harder problem behind it. `MAX_ALT_SAFE` is the altitude at
which the optical train collides with the mount. It is measured from the physical
hardware, per instrument, and the rule is absolute: never guessed, never
defaulted. On a partner's telescope, the person with access to the hardware is the
owner — untrained, unsupervised, and measuring the number that protects their own
property from their own equipment.

The same shape of problem applies to site coordinates. Sun avoidance is computed
from latitude and longitude. A partner who mistypes them gets an arithmetically
correct Sun position for the wrong sky, and the Sun is the one hazard that
destroys a camera and can injure whoever is standing beside the telescope.

## Decision

**A partner-owned telescope may accept customer commands while its owner is
absent, and only under a qualification the operator granted and can revoke.**

"Attended" is replaced, for partner nodes only, by **qualified**. First-party
real-hardware operation is unchanged: it still requires an attended operator
action, because the first-party instrument is where new procedures are proven.

A node reaches `APPROVED` only when all of the following are true, and returns to
`DRAFT` — refusing everything — if any stops being true:

| Condition | Why it is not optional |
| --- | --- |
| A **measured** safety envelope for that instrument, with evidence an operator reviewed | It is the number that stops the OTA hitting the fork. An unmeasured envelope already refuses every slew in both the cloud and the agent; approval must not be the thing that bypasses that. |
| Site coordinates **verified against the sky**, not merely typed | A plate solve at first light proves the site is where the owner says it is. Sun avoidance is only as true as the coordinates under it. |
| A horizon mask and azimuth sectors recorded for the site | A partner's roofline, neighbour's wall and street lamp are not Darkview's, and the mount must not be driven into them. |
| A supervised first light: at least one full mission run end to end with an operator watching | A procedure never run on this instrument is a hypothesis. |
| Park proven on that hardware — commanded, and on link loss | Park is the answer to every unresolved condition. If it has not been seen to work here, nothing else in this table matters. |
| The owner has accepted the operating terms, in writing, for that node | Somebody else's property is being moved by strangers. |

**Nothing about the command path changes.** A partner node runs the same agent,
re-validates every command locally, enforces its own envelope after the cloud link
dies, and refuses a cloud-approved command that fails local safety. The Sun
exclusion remains unreachable from any parameter on any path. Partner status
widens *who may host a telescope*, never *what a telescope may be asked to do*.

**Availability is the owner's, revocation is the operator's.** The owner opens and
closes hours through `NetworkAvailabilityWindow`. The operator can suspend a node
or revoke its device token in one row, and that is the emergency stop for a
telescope nobody is standing next to.

**First-party remains the product; partners are capacity and geography.** A
customer books the Darkview experience in Tbilisi. A partner node is offered as
what it is — a different instrument, a different sky, sometimes a clear one when
Tbilisi is clouded out — and never silently substituted for the first-party
telescope. This is deliberate: the reason to prefer Darkview over a federated
network is that Darkview can promise the instrument, and a promise that quietly
becomes "some telescope, somewhere" is not one.

## Why this route

- **The revocable credential is already the whole security story.** A partner node
  gains no standing authority it did not have; it holds the same single token, and
  the same single row revokes it. Nothing about a partner is trusted more than the
  first-party observatory, which is itself treated as the least-trusted machine in
  the system.
- **Fail-closed is already the resting state.** `DRAFT` refuses. An unmeasured
  envelope refuses. A missing site refuses. The work is to build a path *out* of
  refusal that an operator signs, not to build a new set of refusals.
- **Qualification is a procedure, not a promise.** Every row in the table above
  produces evidence a person looked at. That is also what protects Darkview if a
  partner's mount is ever damaged: the conditions were decided in advance and
  recorded, rather than assumed.
- **The alternative — trusting a form — is the one that ends with a broken
  telescope.** A partner who types `MAX_ALT_SAFE: 85` because the field was
  required is indistinguishable, to the software, from one who measured it.

## Alternatives considered

**Keep the attended rule and let partners operate only while watching.** Honest,
and it deletes the feature: the value is a telescope earning while its owner
sleeps or travels.

**Sell a Darkview hardware bridge, like SkyMapper's SkyBridge.** Rejected. It
imports a hardware supply chain, a support burden and a manufacturing cost into a
product whose entire advantage here is that the agent is already software-only.
The dongle solves a problem Darkview does not have.

**Accept any telescope with no qualification, and rely on the agent's envelope.**
Rejected. The agent's envelope is only as good as the numbers in it, and on an
unqualified node nobody has checked those numbers. This is the option that looks
like the current architecture and quietly removes the measurement rule.

**Let partners self-certify with a signed waiver.** Rejected as the primary
control. A waiver settles who pays for a broken mount; it does not stop the mount
breaking, and "the customer agreed" is not a safety mechanism.

## Consequences

- **`CLAUDE.md` § Hardware safety must be amended** — the exact replacement is at
  the end of this record. It does not land until this ADR is approved, because a
  controlling document must not point at a decision that has not been made.
- **The first-party hardware qualification comes first.** A stranger's telescope
  cannot be certified with a procedure Darkview has never run on its own. DV-034
  precedes any partner node accepting a customer.
- **Cameras become the real hardware limit, not mounts.** Alpaca covers ASCOM
  mounts broadly; the camera path is pinned to the ZWO ASI SDK. `CameraDriver` is
  an interface and swappable by design, but each additional camera family is real
  work and will decide who can actually join.
- **New operator work exists.** Reviewing a qualification is a job, and it does not
  scale by itself. The admin surface DV-063 built is where it belongs.
- **Liability and insurance are open, and are not engineering questions.** Who pays
  when a partner's mount is damaged is a decision for the maintainer with advice
  that is not available in this repository.
- **`ADR-005` (installation site) is unaffected.** It records where the first-party
  observatory lives. A partner node has a site of its own, verified per node.

## What this deliberately does not decide

- **Revenue share with partners.** A payment question, behind DV-056.
- **Whether partner captures enter the public gallery**, and under whose name.
- **Cross-border operation.** A telescope in another country raises questions about
  data, consumer law and the operator's duty that this record does not touch.
- **How many nodes one operator can supervise.** That is an operational limit to be
  measured, not asserted here.

## When this would be revisited

- The first damaged partner instrument, whatever the cause.
- Any proposal to grant a partner node standing authority the operator cannot
  revoke in one row, which is the thing this record exists to refuse.
- Evidence that qualification review does not scale, which would be an argument for
  fewer, better partners rather than a lighter procedure.

## The amendment this record authorises

On approval, `CLAUDE.md` § Hardware safety replaces:

> - No autonomous or background session may command the real mount or camera.
> - Real-hardware mode requires an explicit, attended operator action outside the
>   normal test workflow.

with:

> - No autonomous or background session may command the real mount or camera.
> - Real-hardware mode on a **first-party** observatory requires an explicit,
>   attended operator action outside the normal test workflow.
> - A **partner** observatory may operate unattended only while `APPROVED` under
>   ADR-013, which requires a measured envelope, sky-verified coordinates, a
>   recorded horizon mask, a supervised first light and Park proven on that
>   hardware. It returns to refusing everything the moment any of those stops
>   holding, and an operator can suspend it or revoke its token in one row.

`MAX_ALT_SAFE` is **unchanged and unweakened**: measured from the physical optical
train, never guessed, never defaulted — on a partner's instrument exactly as on
Darkview's own.
