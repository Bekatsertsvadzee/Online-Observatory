# Darkview Platform — backlog

57 issues. IDs are stable across both repositories and never reused. Gaps in the
numbering are intentional headroom.

Detailed acceptance criteria and evidence requirements for each issue are held in the
project planning archive outside this repository. This file is the working index and the
dependency order.

## Conventions

- **Size:** S ≈ half a day, M ≈ 1–2 days, L ≈ 3–5 days, for one person.
- **`[ATTENDED]`** marks an issue that commands real hardware. It requires a human
  operator physically present at the observatory and explicit approval in that session.
  It never runs in CI or from a background agent. Every other issue runs against the
  simulator, which is the default implementation, always.
- No issue may define a cross-boundary type outside `contracts/openapi.yaml`. An issue
  that turns out to need a missing field stops and opens a contract issue.
- Branch naming: `obs/dv-020-agent-skeleton`, `cloud/dv-050-db-schema`, `lead/…`.

## Foundation

| ID | Title | Size |
| --- | --- | --- |
| DV-003 | `contracts:generate` and `contracts:check` | M |
| DV-005 | Pin exact major versions in the root README | S |
| DV-006 | CI pipeline | M |
| DV-007 | `docs/architecture.md` and `docs/OWNERSHIP.md` | S |
| DV-010 | `docs/SAFETY.md` and `docs/RUNBOOK.md` | M |

## Observatory Agent

| ID | Title | Size |
| --- | --- | --- |
| DV-020 | Agent skeleton, configuration, fail-closed defaults | M |
| DV-021 | Outbound WSS link | L |
| DV-022 | Device interfaces and the simulator | L |
| DV-023 | `safety/envelope.py` | L |
| DV-024 | `safety/watchdog.py` | M |
| DV-025 | Command envelope validation | M |
| DV-026 | `mission/runner.py` — the state machine on the simulator | L |
| DV-027 | `state/store.py` — local state and restart replay | M |
| DV-040 | Agent supervisor — command intake and the run loop | M |
| DV-028 | `AlpacaMount` over ASCOM Alpaca HTTP | L |
| DV-029 | `ZwoCamera` via the ZWO ASI SDK | L |
| DV-030 | `solve/astap.py` — plate solving | M |
| DV-031 | Focuser driver and autofocus | M |
| DV-032 | `stream/mjpeg.py` — live view | L |
| DV-033 | `capture/pipeline.py` — live stack, overlay, upload | L |
| DV-034 | `[ATTENDED]` Mount qualification Q1–Q9 and the `MAX_ALT_SAFE` measurement | L |
| DV-035 | `[ATTENDED]` Camera first light and optical train verification | M |
| DV-036 | `[ATTENDED]` First real end-to-end mission | L |
| DV-037 | `[ATTENDED]` Failure drills | M |
| DV-038 | `[ATTENDED]` Evidence run accumulation | M |
| DV-039 | Weather state handling in the agent | M |

DV-026 shipped without the validator wiring it owed; DV-040 paid it. See **What DV-040
wired, and what it deferred** below before touching command intake.

## API, data and realtime

| ID | Title | Size |
| --- | --- | --- |
| DV-050 | Database schema aligned to the contract | L |
| DV-051 | Authentication, sessions and roles | L |
| DV-052 | Target catalogue and the twelve Phase 1 targets | M |
| DV-053 | Ephemeris and visibility engine | L |
| DV-054 | Slot generation from astronomical darkness | M |
| DV-055 | Transactional slot reservation | L |
| DV-056 | Payment integration | L |
| DV-057 | Realtime service: the agent link | L |
| DV-058 | Mission orchestrator, session ownership and command minting | L |
| DV-059 | Cloud-side safety pre-validation and envelope distribution | M |
| DV-060 | Mission client channel and stream relay | L |
| DV-061 | Media pipeline and Collection | L |
| DV-062 | Audit and event log | M |
| DV-063 | Operator/admin API | M |
| DV-064 | Notifications | M |
| DV-065 | Contract: `AGENT_CAPTURE_READY` cannot announce a thumbnail | S |
| DV-066 | Contract: the booking surface has no observatory dimension (ADR-015) | L |

### The two contract issues, and why they exist

Both were raised by work that stopped rather than inventing a field, which is what
`CLAUDE.md` requires: "If a task needs a field that does not exist in the contract,
stop."

**DV-065** is small. `CaptureAssetKind` has a THUMBNAIL and `AGENT_CAPTURE_READY`
has no field to announce one, so `thumbnailUrl` cannot become non-null by any
amount of agent work. ADR-012 listed it as a consequence of the capture path
landing; it is not.

**DV-066 is the one that matters.** DV-120 registers a partner node, DV-121 reads
the hours its owner offered, and neither makes a partner telescope bookable,
because `Slot` cannot say which telescope it belongs to and `CreateBookingRequest`
cannot name one. Both booking surfaces still resolve the observatory with
`findFirst`. Until it lands, the entire partner track is plumbing with no product
at the end of it.

It also carried a defect that was not yet live and would have become live the moment
ADR-015's two slot lengths shipped: `Booking_held_slot_unique` keyed on the start
instant, which is airtight for one fixed duration and silently wrong for mixed ones.
A sixty-minute booking at 21:00 and a twenty-minute one at 21:20 both inserted.
**That half is done** — see *What the slot exclusion constraint closed* below. The
observatory dimension itself is not.

## Observer Pack — server side (ADR-007)

| ID | Title | Size |
| --- | --- | --- |
| DV-100 | Observer seat model and capacity | M |
| DV-101 | Controller opt-in | S |
| DV-102 | Observer Pack payment | M |
| DV-103 | Observer-scoped mission channel | L |

## Loyalty — server side (ADR-008)

| ID | Title | Size |
| --- | --- | --- |
| DV-090 | Scheme configuration — tiers, thresholds, earn and redemption rates | S |
| DV-091 | Contract surface for loyalty in `contracts/openapi.yaml` | M |
| DV-092 | Points ledger — append-only, idempotent by source event | L |
| DV-093 | Earn rules engine — settled payments only | M |
| DV-094 | Tier evaluation and transitions | M |
| DV-095 | Redemption at checkout, atomic with the reservation | L |
| DV-096 | Referral flow with self-referral and abuse guards | M |

## Remaining platform scope

| ID | Title | Size |
| --- | --- | --- |
| DV-110 | Viewing Conditions service | M |
| DV-111 | Refund and reschedule engine | L |
| DV-112 | Observation Pass: gift vouchers | M |
| DV-114 | Backup, restore and disaster recovery | M |
| DV-115 | Security hardening and abuse controls | M |

## Partner observatories (ADR-013, APPROVED)

A telescope somebody else owns joining the network by installing the agent -- no
Darkview hardware, no dongle, no port forwarding -- available during hours the owner
chooses, including while the owner is away.

ADR-013 is **APPROVED** (2026-09-09). It replaces the attended-operator rule for
partner nodes with a qualification an operator grants and can revoke, and leaves
first-party operation unchanged.

`ObservatoryNetworkNode` and `NetworkAvailabilityWindow` already exist in the schema,
with `kind`, `approvalStatus`, `capabilities` and per-weekday windows. Nothing reads
either table. The agent is already software-only, already outbound-only, and already
holds one revocable token scoped to one observatory; Alpaca already makes any ASCOM
mount reachable. What is missing is the qualification path, not the transport.

| ID | Title | Size | Needs hardware? |
| --- | --- | --- | --- |
| DV-120 | Partner node registration and the DRAFT -> UNDER_REVIEW -> APPROVED workflow | M | no |
| DV-121 | Availability windows, feeding the existing slot generator | M | no |
| DV-122 | Operator review surface for a qualification, on the DV-063 admin console | M | no |
| DV-123 | Agent installer and guided first-run setup, exercised against SimMount and SimCamera | L | no |
| DV-124 | Qualification procedure run end to end on the first-party instrument | L | **yes -- DV-034 first** |
| DV-125 | `CameraDriver` implementations beyond ZWO | L | **yes** |

DV-120 through DV-123 are buildable before any hardware exists. DV-124 is the gate:
a stranger's telescope cannot be certified with a procedure Darkview has never run on
its own, so nothing accepts a customer until the first-party qualification has been
performed.

## Build order

**Stage 1 — simulator-first core.** Roughly 60% of this repository can be finished before
the camera clears customs. That is the point of building the simulator first.

```
DV-020 agent skeleton            DV-050 db schema
DV-022 device interfaces + sim   DV-051 auth + roles
DV-021 outbound WSS link         DV-052 target catalogue
DV-023 safety envelope           DV-053 ephemeris
DV-025 command validation        DV-057 agent link service
DV-024 watchdog                  DV-058 orchestrator
DV-026 mission runner (sim)      DV-059 cloud safety
DV-040 supervisor + run loop     DV-062 audit log
DV-027 local state store         DV-060 mission channel
```

DV-027 ran after DV-040 rather than before it: there was nothing to make durable
until something joined the pieces. ADR-010 records what it stores and why.

**Milestone S1 — simulated end to end.** A command traverses API → WSS → agent →
`SimMount`, the mission runs the full state machine, and the operator console shows it.
Everything is real except the hardware.

**Stage 2 — hardware qualification** (attended, gated on hardware arrival and site
permission): DV-034 → DV-028 → DV-035 → DV-029 → DV-030 → DV-031.

**Stage 3 — the first real mission:** DV-036.

**Stage 3.5 — Observer Pack:** DV-100, DV-101, DV-103 immediately after S1, because
DV-103 changes how the mission channel fans out and retrofitting it later is a rewrite.
DV-102 lands with DV-056.

**Stage 4 — the live experience:** DV-032, DV-033, DV-039, DV-061, DV-063.

**Stage 5 — booking and payment:** DV-054, DV-055, DV-056, DV-064, DV-110, DV-111,
DV-112, DV-115. **DV-066 comes before anything sells a second slot length**, and
before DV-122 or DV-123 are worth building.

**Stage 6.5 — loyalty:** DV-090 … DV-096, behind DV-056.

**Stage 7 — freeze and prove:** DV-114, DV-037, DV-038.

## What DV-060 built, and what it did not

The mission client channel is live: `/ws/mission/{missionId}`, authenticated by the
browser session cookie behind an Origin check, subscribed with `CLIENT_SUBSCRIBE`, and
fanned out to every subscriber on the mission. `AGENT_STATE_DELTA`, which the cloud had
been recording and discarding since DV-057, now reaches customers as `MISSION_TELEMETRY`.

**The fan-out is a set per mission from the first commit**, not one channel per mission.
DV-103 adds observers to exactly that collection, and this table is the reason it is an
edit rather than the rewrite the stage list warns about.

| Client message | What happens |
| --- | --- |
| `CLIENT_SUBSCRIBE` | Admitted only when the URL's mission, the message's mission and the presented session's mission all agree, and the session belongs to the authenticated user. Every refusal is worded identically. |
| `CLIENT_PING` | Keep-alive. No reply: `MissionChannelMessage` has no pong, and inventing one would be a message outside the contract. |

| Agent message | Reaches the client as |
| --- | --- |
| `AGENT_MISSION_EVENT` | `MISSION_STATE`, but only on `APPLIED`. A transition that arrived after a terminal state is an ordering artefact, not news about a telescope. |
| `AGENT_STATE_DELTA` | `MISSION_TELEMETRY`, narrowed to the contract's client-safe fields. Device health, pointing, focuser position and agent version stop at the cloud. |
| `AGENT_COMMAND_ACK` | `MISSION_COMMAND_RESULT`, routed by the **minted command row**, never by the ack's own `missionId`. |

**`MISSION_STREAM` was deferred here and is now built.** The contract describes two
live-view paths and does not join them: the agent pushes `AGENT_LIVE_FRAME` plus a binary
frame up its own link, and the client is told a `streamUrl` it reads frames from. Nothing
said where the bytes were held, what served them, or what signed the URL, so DV-060 built
everything else and stopped — a fabricated `streamUrl` would have been worse than an
absent one. **ADR-011** answered it and DV-032 implemented it; see below.


**New required environment variable: `APP_URL` on the realtime service.** The only origin
a mission-channel handshake may come from. It has no default on purpose — a permissive
fallback would silently disable the check that stops another site opening a subscription
as a signed-in customer. It must be added to `.env.example` and to the deployment
environment before the service starts.

The mission channel also constrains deployment: the session cookie is `__Host-` prefixed
in production, so the browser sends it only to the host that set it. **The realtime
service must be served from the same host as the web app**, on a path, not on a
`realtime.` subdomain.

## What DV-032 built

The live view, end to end against the simulator. The agent encodes a frame and pushes it
up its existing link; the realtime service holds it and serves it; the customer is told
where to look.

| Step | What happens |
| --- | --- |
| Agent | Stretches a 16-bit frame, encodes JPEG, sends `AGENT_LIVE_FRAME` followed by exactly one binary frame. **Never queued** — a live frame is worthless once the next exists, and replaying a backlog after an outage would show the sky as it was. |
| Realtime, agent side | Pairs the header with the bytes that follow it, checks the mission is this observatory's, and keeps **one frame per mission** in memory. Not recorded in `AgentMessage`: that table makes the agent's replay idempotent, and a frame is never replayed. |
| Realtime, client side | Sends `MISSION_STREAM` — but only once a frame has actually arrived, and at most one offer per client until it is near expiry. A URL per frame would mean reopening the response every second. |
| Realtime, HTTP | `GET /stream/mission/{missionId}?t=…` answers `multipart/x-mixed-replace`, which is what an `<img>` consumes with no library. The service's first HTTP surface beyond the upgrade handshake. |

**Three independent checks on every stream request**, not one. The session cookie proves
somebody is signed in; the signed token proves the URL was minted for that same person and
bounds how long a copied `src` keeps working; and `mayWatchMission` proves they are *still*
entitled. Without the third the token would be a five-minute bearer credential, and an
observer whose controller closed the mission would keep being served until it lapsed.

**Every refusal is the same 404** — not signed in, forged token, expired token, somebody
else's token, unknown mission, no frames yet, seat withdrawn. The mission channel already
refuses on that rule, and a second surface answering more precisely would undo it.

**Memory is released on mission end, on link loss, and on staleness.** The first two are
explicit; the third exists because nothing announces that an agent crashed, and a process
designed to run for months must not accumulate the last frame of every mission it carried.

**New required environment variable: `STREAM_SIGNING_SECRET` on the realtime service.**
No default, minimum 32 characters. A fallback would leave the signature check running
against a value anybody reading this repository knows, which is worse than not signing
because it looks like it works. It is separate from `AUTH_SECRET` on purpose: one signs
sessions, the other signs view-only URLs, and a key used for two jobs cannot be rotated
for one of them.

**The tuning numbers are provisional.** Resolution, JPEG quality and frame rate were
measured against `SimCamera`, because ADR-011 assigns the real measurement to the ASI585MC
and that hardware does not exist yet. They are marked PROVISIONAL at every definition and
DV-035 replaces them. They are not safety values; nothing in this path can move a mount.

## What DV-120 built, and the one number an operator may not attest

The path out of refusal for a partner observatory (ADR-013). Everything else about
a partner node already refuses; this is the single deliberate act that lets a
telescope somebody else owns be operated by somebody neither of them has met.

| State | What it grants |
| --- | --- |
| `DRAFT` | Nothing. The resting state, and where registration leaves a node. |
| `UNDER_REVIEW` | Nothing. The owner saying the telescope is set up. |
| `APPROVED` | Unattended operation, and only this. |
| `SUSPENDED` | Nothing. Distinct from DRAFT on purpose -- see below. |

**Registration creates the site, the instrument and the node in one transaction.**
A partner has none of the three beforehand, and a site with no node is a
half-registration somebody has to clean up. The observatory is created OFFLINE,
SIMULATED and with **no device token**, which is what the link service reads as "no
agent may connect" -- so a freshly registered node cannot be reached even by
somebody who knows its identifiers.

**Five conditions are attested; the sixth is checked.** No query can tell whether a
person watched a park or walked a horizon, so ADR-013's five human conditions are
attested by the operator as separate fields -- separate because they are separate
things somebody had to go and do, and one combined "I confirm" is a box that gets
ticked without reading. Each is recorded verbatim in the audit row, so an approval
is a statement somebody can be held to.

**The sixth is `MAX_ALT_SAFE`, and it is deliberately absent from that list.** It is
where the optical train meets the mount, the database knows whether it has been
measured, and a checkbox for it would let an unmeasured telescope be approved by
clicking -- on somebody else's property. Approval reads the envelope and refuses
with `SAFETY_NOT_CONFIGURED`. A missing envelope row and a row with a null limit are
the same fact and both refuse; only one of them looks like a mistake.

**`SUSPENDED`, not `DRAFT`.** ADR-013's prose says a suspended node "returns to
DRAFT"; the schema already had four states, its author had not noticed, and the
schema is right. Both refuse everything. What the distinction preserves is the
difference between a telescope nobody has ever qualified and one whose
qualification was taken away, which is the history an operator needs before
granting it again. The record now carries a dated correction saying so.

**Suspension is never refused, and it stops what is running.** The same rule DV-115
applies to Park: anything that stops a telescope is not something a limiter or a
conflict check may delay. An already-suspended node suspends again without
complaint, and a live mission is a reason to suspend rather than a reason to wait --
the opposite of how a mode switch behaves, because a mode switch starts something.
The running mission is ended through DV-063's operator cancel rather than by writing
mission rows here: that path already parks the mount, revokes the session and tells
the agent, and a second implementation would be a second chance to get stopping a
telescope wrong.

**Verified by removing each protection and confirming a named test fails:** the
measured-envelope check, the five attestations, the UNDER_REVIEW gate, the owner
scope on submit, the clearing of `approvedAt`, and the cancellation of a running
mission. That last one had no test until the injection asked for it -- the code was
written and nothing held it, which would have made "an operator can revoke it in one
row" a claim about paperwork rather than about a mount that is moving.

**Two things the run caught that were not DV-120's.** The metered-routes invariant
flagged the suspend route, which is unmetered on purpose and is now recorded as
such. And a stray test fixture had been left in `apps/realtime/src/server.ts` by the
capture-storage work -- an unused const in a production file, which lint reported as
a warning and nothing failed on. Both fixed here.

## What the capture storage work built, and what still has no bytes

ADR-012 named its own first task: "A new cloud-to-agent message granting the
presigned PUT, and an agent-to-cloud message asking for one. That is a contract
change, and it is the first thing to do after this record is approved." That, and
the cloud half behind it.

**The contract change.** `AGENT_UPLOAD_GRANT_REQUEST` and `CLOUD_UPLOAD_GRANT`,
regenerated into TypeScript, Zod and Pydantic. The request carries no key field at
all -- the cloud derives the key, so there is nowhere for an agent to propose one,
and `additionalProperties: false` turns an agent that tries into a validation
failure rather than a decision this code has to make.

| Piece | Where |
| --- | --- |
| Key derivation and presigning | `packages/storage` -- both services need it, the same reason `audit.ts` and `rate-limit.ts` live in `packages/db` |
| The grant | `apps/realtime`, on the link that already authenticates the agent |
| The download | `apps/api`, `GET /captures/{captureId}/download`, behind the ownership check `GET /captures/{id}` already applies |

**SigV4 is `@smithy/signature-v4`, not hand-rolled.** A mistake in canonical
request construction produces a URL that looks correct and is refused, and there is
no way to prove a bespoke implementation right without the bucket this code exists
to reach -- a pinned "expected signature" would be a constant nobody can check. The
full S3 client is 3.3 MB to build a URL; the signer is 106 KB and signs identically
for R2, B2 and MinIO, which is what ADR-012 requires. What this repository owns, and
what its tests hold it to, is *what* gets signed: the object, the method, the
expiry, the bucket. Each is proven by changing one and watching the signature move.

**Two authority checks on a grant, worded identically.** The command is loaded
first because it carries both the mission and the observatory it was minted for, so
one read answers "is this real" and "is it ours". A request naming a command from
another observatory, a command that does not exist, and a real command cited
against the wrong mission all get the same sentence: a probing agent must not be
able to tell them apart.

**Both services refuse to start without a bucket.** ADR-012's words, and the
contract leaves no alternative -- `GET /captures/{captureId}/download` declares 200,
401 and 404 and has no way to say "this deployment has no storage". `apps/api` uses
Next's `instrumentation.ts`, whose `register` runs once and must complete before the
server accepts a request; `apps/realtime` reads the configuration before it accepts
a socket.

**Not built at the time: the agent half.** The Python agent did not ask for a
grant and did not upload. The Pydantic models existed, so the messages were typed
on both sides, but nothing sent one. That is the other half of DV-061; it is now
built, and the section below records what that turned out to involve.

**A dated correction to this record.** The sentence above originally read that the
agent "still reports storage keys it invented". It did not. The agent had never
sent `AGENT_CAPTURE_READY` at all: `CAPTURE` was on the supervisor's
`UNIMPLEMENTED_COMMANDS` list and was refused outright, and `_do_processing` was a
stub that transitioned straight to COMPLETE. The missing work was the whole capture
path, not an upload bolted onto an existing one. Corrected 2026-09-10, when the
agent half was picked up and the claim did not survive contact with the code.

**`thumbnailUrl` is still null, and it is not the agent's to fix.** ADR-012 lists
it as a consequence of the whole path landing. It is not: `AGENT_CAPTURE_READY`
carries `imageStorageKey`, `unmarkedStorageKey` and `fitsStorageKey` and has **no
field for a thumbnail**, so an agent that rendered and uploaded one would leave an
object in the bucket that no message can name and no row can reference. It needs a
contract change. See the open question below.

**Orphaned objects are now possible**, as ADR-012 said they would be: an agent that
uploads and loses the link before reporting leaves an object no row names. The sweep
for unreferenced keys belongs with operator tooling and does not exist.

**Verified by removing each protection and confirming a named test fails:** the
download's ownership scope, its asset-kind scope, the grant's observatory check, the
grant's mission check, and the key derivation's refusal of anything that is not a
UUID. One test passed the first time and was rewritten -- the identical-wording check
compared a set of one against itself, because the helper that brings a link online
clears the recorded messages.

## What DV-121 built, and why a partner still cannot be booked

`NetworkAvailabilityWindow` has existed since the schema landed, the seed fills
seven rows of it, and nothing read any of them. Now the slot generator does.

**Windows intersect darkness; they never replace it.** An owner offering two in
the afternoon has not created a slot -- the agent's Sun avoidance would refuse the
slew, so selling it would be selling something the observatory is built to refuse.
Availability can only take hours away from the dark window.

**No windows means no restriction.** A node with nothing recorded is offered
across the whole night, which is what every deployment does today. Treating
silence as "not offered" would have emptied the slot list of every existing
installation the moment this shipped, and an owner who has not thought about
hours has not thereby withdrawn their telescope. A window switched off with
`enabled` is indistinguishable from one never recorded, deliberately.

**A night spanning midnight is two rows, not one that wraps.** The table is keyed
by weekday, so Friday night's late hours are Saturday's early window, and both
weekdays are read for one night. A row whose end is not after its start is
discarded rather than guessed at: 22:00-02:00 is ambiguous about which day it
lands on, and inventing an answer would offer somebody else's telescope on a
night nobody chose. `endMinute` 1439 is 23:59, not midnight -- an owner who means
one unbroken night writes 1440, and the tests hold both readings.

**Slots are tiled per opening, not across the night and filtered.** A gap the
owner left is a gap: carrying the stride over it would place a slot start inside
hours they did not offer.

**The booking path narrows identically, and that is the half that matters.**
`GET /slots` hiding a slot while `POST /bookings` still accepted it would be worse
than neither, because the grid is public and predictable -- a customer who read one
page of it could name the instant directly. `findGeneratedSlot` now generates per
open interval too.

**Only an APPROVED node's windows are read.** A node in DRAFT, UNDER_REVIEW or
SUSPENDED is not offered to anybody, so its recorded hours are not a statement
about availability; reading them would let a suspended telescope keep shaping the
booking page.

**What this does not deliver: a partner telescope anybody can book.** That is a
contract wall, not an omission.

| Missing | Where |
| --- | --- |
| No endpoint for an owner to set their hours | "availability" appears nowhere in `contracts/openapi.yaml` |
| `Slot` cannot say which telescope it is on | `Slot` has no `observatoryId` |
| `CreateBookingRequest` cannot name one | nor does it |
| `GET /slots` takes only a date | no observatory parameter |

`reserve.ts` has said so since DV-055: "Phase 1 is one observatory. When there is
more than one this takes an id." Both surfaces still resolve the observatory with
`findFirst` ordered by `createdAt`, so a second bookable observatory is invisible
whatever its windows say. Until that contract change lands, DV-121 constrains the
one observatory the platform already serves -- which is real and testable, and is
not the same as partner bookability. It needs a contract issue, alongside the
`thumbnailStorageKey` one.

**Verified by removing each protection and confirming a named test fails:** the
two-weekday read, the merge of touching intervals, the discard of a backwards
window, the no-windows fallback, and the clip to darkness. The booking-path
enforcement and the APPROVED-only filter are covered by integration tests that
need PostgreSQL and were not run on this machine -- CI runs them.

## What the agent capture path built, and the field the contract is missing

The other half of DV-061. `CAPTURE` was refused as unimplementable, `_do_processing`
was a stub, and the cloud's grant and download surfaces had nothing to talk to.

| Piece | Where |
| --- | --- |
| Profile to exposure, gain and frames | `agent/darkview_agent/capture/profiles.py` |
| The caption burned into the delivered image | `capture/overlay.py` |
| The stack rendered as IMAGE and UNMARKED | `capture/deliverable.py` |
| The presigned PUT, on its own thread | `capture/upload.py` |
| Grant request, grant handling, `AGENT_CAPTURE_READY` | `supervisor.py` |

**OBSERVING now waits for a person.** It used to transition to CAPTURING on the
next pass, which left no window in which a customer could press Capture at all. It
holds for a bounded dwell instead, and a capture request ends the wait. When none
comes the mission still passes through CAPTURING -- CLAUDE.md's state list is
linear and every mission visits it -- and PROCESSING delivers nothing. The dwell is
PROVISIONAL: the real figure is the slot's length, which the agent is not told.

**The upload runs off the run loop, on a worker thread.** Everything else in the
agent is a polled state machine, and the loop holds the watchdog's device lock on
every pass. A capture is hundreds of kilobytes over an observatory uplink, so a
blocking PUT inside `pump()` would put a network stall between a heartbeat and a
Park. stdlib `urllib`, so no new dependency.

**The agent proposes no key and reports the cloud's.** `AgentUploadGrantRequest`
has no field for one and `additionalProperties: false` makes an agent that invents
one a validation failure. What comes back on the grant is what is uploaded to and
what `AGENT_CAPTURE_READY` reports, which is what makes `CaptureAsset.storageKey`
trustworthy.

**The presigned URL is treated as a credential.** It is the observatory's entire
authority over object storage, so every message leaving `upload.py` is scrubbed of
it -- the same rule `link/websocket.py` applies to the device token.

**A simulated capture says SIMULATED on the face of the image.** CLAUDE.md forbids
presenting simulator output as real telescope output. A `mode` column does not
survive a screenshot; the caption does.

**A capture with no IMAGE is not reported at all.** `imageStorageKey` is required,
so there is no honest message to send. A lost UNMARKED costs the optional asset and
nothing else.

**Not built: FITS.** Nullable in the contract, and writing one means a FITS library
and a header convention that has to agree with whatever a customer opens it in.
`fitsStorageKey` stays null.

**Open contract question: there is no `thumbnailStorageKey`.** THUMBNAIL is a
`CaptureAssetKind` the cloud can store and the agent has no way to announce.
Until `AGENT_CAPTURE_READY` gains the field, `thumbnailUrl` cannot become non-null
by any amount of agent work. Two things need deciding together: the new field, and
whether `apps/api/src/features/shared-observations/data.ts` should keep deriving a
thumbnail from `capture.assets.at(0)` -- which today takes whichever asset happens
to be first rather than the THUMBNAIL.

**New optional setting: `DARKVIEW_AGENT_OPTICAL_CONFIG`.** Which optical train is
fitted, reported on every capture. Defaults to `F10_NATIVE` -- the C6 with nothing
added, the only configuration that is true by default. Unlike `MAX_ALT_SAFE` it is
not a safety value: getting it wrong mislabels a focal length rather than letting a
telescope hit something, which is why it has a default at all.

**Verified by removing each protection and confirming a named test fails:** the
grant's mission check, the unknown-capture check, the PUT-only rule, both halves of
the URL scrub, the grant-expiry check, the required-IMAGE rule, the SIMULATED
marking, and the refusal of a second capture once the run has started. The
query-string half of the scrub was found to be unheld on the first pass -- the
whole-URL replacement was catching every case the test tried -- and has its own
test now.

## What DV-114 can prove, and what it cannot

Everything the platform knows is in one PostgreSQL database. There was no way to copy it
and no procedure for putting it back.

**Two scripts and a drill.** `npm run backup` dumps and then reads its own output back,
because a backup nobody has read is a hope; `npm run restore` puts one back, and refuses
loudly. The drill is the part that matters: an integration test that takes a real dump,
restores it into a scratch database, and compares the two.

| Refusal | The failure it is for |
| --- | --- |
| `pg_dump` older than the server | A dump taken by an older client can be silently incomplete, and the failure surfaces at restore time. |
| An archive `pg_restore --list` cannot read | The file exists and is not a backup. |
| An archive with no data entry for the core tables | The quiet one. Point the backup at a database that exists but was never migrated and pg_dump succeeds, writes a valid archive, and leaves something that looks exactly like a backup and holds nothing. |
| `--confirm` disagreeing with `--to` | A restore aimed at the wrong database. |
| An unreadable archive, checked *before* `--clean` runs | Order, not refusal: discovering it afterwards turns a database that could have been left alone into an empty one. |

**A restore revokes every session it brings back.** A restored `Session` row is a live
cookie from a past moment -- including one held by whoever caused the incident being
recovered from. `--keep-restored-sessions` exists and is named for what it does.

**The drill compares index definitions, not index names.** A name surviving proves nothing:
`Booking_held_slot_unique`, `Mission_active_per_observatory_unique` and
`MissionSession_active_owner_unique` are only worth anything if the `WHERE` clauses that
make them partial came back too. Those clauses are what stops two people booking the same
half hour -- DV-055 proved the index is what enforces it, and this proves a restore does not
quietly drop it.

**A found trap, in the URL itself.** `postgresql://.../darkview?schema=public` is a valid
Prisma URL and not a valid libpq one -- psql answers `invalid URI query parameter:
"schema"` -- so the string that runs the application cannot be handed to pg_dump unchanged.
Both scripts strip the Prisma-only parameters.

**Not backed up, deliberately:** the agent's local state store, which is a crash journal
rather than a record and must never be copied between observatories; capture bytes, which
have no object storage yet (ADR-012); and secrets, which are not in the database.

**What this does not prove.** There is no production infrastructure, so there is no
retention policy, no off-site copy, no schedule and no measured recovery time. The drill
restores a nearly empty database in seconds and that number says nothing about a year of
captures. `docs/RUNBOOK.md` §8 marks the whole of it **[UNEXERCISED]** against real
infrastructure and lists the decisions owed.

**Verified by removing each protection and confirming a named test fails:** the `--confirm`
guard, the session revocation, the unmigrated-database check, and the order of the archive
read. The first passed the first time and was rewritten -- it aimed at a database that did
not exist, so `pg_restore` failed for its own reasons and the test proved only that you
cannot restore into a database nobody created.

## What DV-115 metered, and the one rule behind it

Rate limiting existed before this and was wired to two call sites: sign-in and
register. Everything else an authenticated account could do -- reserve slots,
mint commands, churn observer seats, write the safety envelope -- was unmetered.

**The primitive did not change.** `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
in one statement, so concurrent attempts serialise on the row lock instead of
racing; `X-Forwarded-For` read from the right, bounded by `TRUSTED_PROXY_HOPS`,
trusting nothing by default. What changed is that it now lives in
`packages/db/rate-limit.ts`, for the reason `audit.ts` does: both services need
it, and two implementations of a decision that is only correct in one statement
is two chances to get it wrong. `apps/api/src/lib/security/rate-limit.ts` holds
what is specific to this service -- who is asking, which policy, what a refusal
looks like on the wire.

**One rule decides every exemption: anything that stops the telescope is never
metered, anything that starts or widens it is.**

| Path | Metered? |
| --- | --- |
| `POST /admin/override` carrying `PARK` or `ABORT` | Never. A limiter able to delay an emergency stop is a regression dressed as hardening -- the moment an operator most needs Park is the moment they have been hammering the console. |
| `POST /admin/observatory/weather-hold` declaring a hold | Never. Phase 1 has no sky sensor, so an operator at a window is the only thing that can call the weather unsafe. Clearing a hold is metered. |
| `POST /admin/missions/{id}/cancel` | Never. It releases the observatory, and there is one active mission at a time, so cancelling in a loop cancels the same mission repeatedly. |
| Everything else that mutates | Metered, and `metered-routes.test.ts` fails if a new mutating route lands without it. |

**The exemptions are functions, not conditions at a call site.**
`overrideIsExemptFromMetering` lives next to `RECOVERY_COMMANDS` and
`weatherHoldIsExemptFromMetering` next to `setWeatherHold`, so neither can drift
from the thing it is about, and both are testable without a request.

**The override exemption reads both `type` and `payload.kind`, where the safety
pre-check reads only the payload.** That is not an inconsistency. The safety
check reads the payload because the payload says where the telescope ends up.
This one is deciding whether to *skip* a check, so it fails the other way: a
request whose halves disagree is not a Park, it is the 422 that DV-063's injected
bug taught us to expect -- and unmetered refusals are exactly what an attacker
would want unlimited attempts at.

**A found hole, in the code this inherited.** Registration was metered on
`address:email`, so a fresh email address was a fresh bucket: it capped attempts
at one account and not the number of accounts one client could open.
`consumeRegistrationOriginLimit` caps that -- and returns true unconditionally
for an unattributed actor, because keyed on the fallback constant it would be one
bucket shared by every customer in the world and the eleventh person to register
anywhere would be locked out for an hour. So the cap is real only once
`TRUSTED_PROXY_HOPS` is set, which `.env.example` now says.

**A refusal is an audit row.** Category by surface, action `RATE_LIMITED`,
`detail.scope` naming the bucket. DV-063 deferred exactly this: without it a
customer locked out of their own observation and a script being turned away look
identical in the logs.

**Not built: the realtime service's own metering.** `packages/db/rate-limit.ts`
is where it will go and takes no Next dependency for that reason, but nothing in
`apps/realtime` calls it yet. The exposure is genuinely smaller -- a mission
handshake already needs a valid session cookie behind an Origin check, and a
live-view token is a 256-bit HMAC, so neither is guessable -- and an
unauthenticated connection flood is a transport concern that belongs to whatever
proxy terminates TLS. It is deferred, not overlooked.

**Not built: anything payment-shaped.** Checkout abuse, voucher fraud and refund
churn are the other half of DV-115 and none of it can be written before DV-056.

**Verified by removing each protection and confirming a named test fails:** the
override's two-sided exemption, the weather-hold direction, the audit row, the
per-route metering, the unattributed-actor escape hatch, the fail-closed branch,
and reading `X-Forwarded-For` from the trusted end. The per-route check passed
the first time and was rewritten: it asserted a route *mentioned* `meterRequest`,
which an unmetered route with a surviving import line satisfies.

The two routes that already had unit tests -- bookings and mission command --
gained one apiece asserting the refusal lands *before* the domain is asked. That
ordering is the point rather than a detail: a booking metered after the fact has
already held a slot, and a command metered after the fact is a command the
telescope has already been asked to obey.

## What DV-063 built, and the one endpoint it could not

Six of the seven remaining admin operations. `/admin/logs` and
`/admin/observatory/safety-envelope` already existed.

| Endpoint | What it is for |
| --- | --- |
| `POST /admin/override` | Operator manual control, including **the emergency Park**. The gap `docs/SAFETY.md` recorded. |
| `POST /admin/observatory/mode` | SIMULATED / REAL, gated on a written reason and an asserted attended presence. |
| `POST /admin/observatory/weather-hold` | The only thing in Phase 1 that can declare the weather unsafe. |
| `GET /admin/missions` | Every mission, unscoped by user, keyset-paged. |
| `POST /admin/missions/{id}/cancel` | Ends a stuck mission and **releases the observatory**. |
| `PATCH /admin/targets/{id}` | Enable, disable or tune one catalogue target. |

**The override does not escape safety, and cannot.** It runs the same
`evaluatePointing` a customer's command runs, the agent checks again independently,
and the Sun exclusion is unreachable from any parameter on this path. What the
override actually widens is *who may issue a command* — it commands around the
customer's session rather than through it, which is why every one of them, relayed
or refused, is written under `OPERATOR_OVERRIDE` with the operator's identity and
their verbatim reason.

**The envelope names the session's owner as `userId`, not the operator.** The agent
refuses any envelope whose userId is not the session owner it holds, so an override
that put the operator there would be refused at the observatory — the opposite of
what an emergency stop must do. `issuedByOperatorId` is the field the contract
added for exactly this.

**A found bug, from injecting one.** The recovery exemption that keeps a Park from
ever being refused on envelope grounds was originally keyed on the command `type`
while the safety check read the `payload`. Since the override is the one path that
takes both from a request, `type: PARK` with a `GOTO` payload would have carried a
slew past the pre-check under a Park's name. The contract already says
`payload.kind` MUST equal `type`; that check now exists here, and the exemption
reads the payload.

**Not built: `GET /admin/observatory/state`.** `OperatorObservatoryState.telemetry`
is a required `ObservatoryTelemetry`, carrying `DeviceStatus` for the mount, camera
and focuser. **Nothing stores those.** `AGENT_STATE_DELTA` is deliberately relayed
and never recorded — "writing every delta would grow a table without answering a
question" — so the only copy of live telemetry is in the memory of the realtime
process, and `apps/api` is a different process. A half-answer that reported
DISCONNECTED would be true only while the link is down, which is the opposite of an
operator console's purpose.

Where live telemetry lives is the same shape of question ADR-011 answered for
frames, and it is owed the same kind of decision record before any code fills it
in. The plausible answers are a single throttled latest-telemetry row, or the
realtime service exposing it on its own HTTP surface the way it now serves the live
view. **This is a maintainer decision and is not made here.**

## What DV-039 built, and the contract change it is waiting on

A weather hold now reaches the mission that is already running. Before this it only
refused the next one: `startMissionSession`, `POST /bookings` and the slot and
target listings all consult `holdActive`, so an operator watching cloud roll in
could stop the next customer and not the one holding the telescope.

Setting a hold, when a mission is live, does three things in one transaction and in
an order that is not arbitrary:

1. **A PARK is minted and relayed first**, while the session is still valid. The
   agent refuses any envelope whose sessionId is not the owner it currently holds,
   so a Park sent after the revocation would be refused — and the mount would keep
   tracking under a sky the operator has just called unsafe.
2. **The mission moves to WEATHER_HOLD** with `WEATHER_UNSAFE`, filed as a `CLOUD`
   event because the cloud decided it. A hold is not terminal; it leaves
   `Mission_active_per_observatory_unique`, which is safe because every new session
   is refused while the hold stands.
3. **The session is revoked.** The customer keeps the page; they stop keeping the
   telescope.

**Clearing a hold resumes nothing.** It says the sky is safe again. It does not say
the customer still wants their session, that their slot has time left, or that the
mount is where it was. Resuming is a decision and nobody has made it.

**Not built: the agent's own weather enforcement.** `Watchdog.weather_unsafe` still
has no caller, and this is a contract gap rather than an omission. There is **no
cloud-to-agent weather message**: `CloudToAgentMessage` carries welcome, command,
heartbeat ack, session update, safety envelope update and error, and none of them
says anything about the sky. So the agent obeys a Park it cannot attribute, and
files the mission locally as an operator abort while the cloud's own record
correctly says weather.

That matters for the reason every other safety rule here is enforced twice. The
agent keeps enforcing its safety envelope after the link dies; it cannot do the
same for a weather hold, because it holds no copy of one. An observatory that loses
its link during a hold has nothing telling it to stay parked.

**The proposal**, which needs maintainer approval before any code: a
`CLOUD_WEATHER_UPDATE` carrying the `WeatherState` the cloud already stores, added
to `CloudToAgentMessage`; a `WEATHER` notification kind alongside ADR-009's
`COMMAND`, `SESSION` and `ENVELOPE`; the state persisted in the agent's local store
next to the safety envelope (ADR-010), so it survives a restart; and
`Watchdog.weather_unsafe` called when a hold arrives. The agent still cannot
*observe* weather — no sensor is fitted, and the contract is explicit that SENSOR is
"only used if a sensor is actually fitted" — so this is about acting on being told
and continuing to act after the telling stops.

## What DV-061 built, and what it is waiting on

A capture is the thing a customer keeps, and the half that does not need the bytes
is done: the agent reports `AGENT_CAPTURE_READY`, the cloud records it, and it
appears in the Collection.

| Step | What happens |
| --- | --- |
| Recording | One `Capture`, its `CaptureAsset` keys, and one `CaptureAccess` for the mission's owner, in a single transaction with an audit row. |
| Idempotency | `Capture_command_unique`. The realtime service already deduplicates by messageId; this puts "one capture per CAPTURE command" in the database, where a future writer or a retry under a fresh messageId cannot get past it. |
| Fan-out | `MISSION_CAPTURE_READY` once, carrying the whole `Capture` so the client shows it without a round trip. A re-sent capture produces no second message. |
| Collection | `GET /captures` and `GET /captures/{captureId}`, keyset-paged, newest first. |

**`Capture.commandId` is new.** `MissionEvent` and `AuditLog` already carried a
commandId; without it the capture was the one artefact of a mission that could not
be joined back to the instruction that produced it. It doubles as the idempotency
key.

**Ordering is by `capturedAt`, not `createdAt`.** A capture the agent queued through
an outage and delivered an hour later belongs where it was taken in the customer's
evening, not above images from a later session.

**Observers get the message and not the image.** ADR-007: "nothing from this mission
enters the observer's Collection". The fan-out reaches every subscriber, because an
observer seeing that a capture happened is the same as seeing the mount slew; the
recorder grants `CaptureAccess` to the mission's own user and nobody else.

**`processingPreset` is recorded as NATURAL and nobody chose it.** The column is
required, has no contract field, and no customer is offered the choice yet. NATURAL
is the preset that applies no additional processing, which is what actually
happened. DV-033 owns `SET_PROFILE` and the mapping; recording BRIGHT or DETAIL now
would claim a choice that was never offered.

**Not built: the bytes.** `GET /captures/{captureId}/download` and the agent's
upload need object storage, which does not exist yet. **ADR-012 is APPROVED** and
answers how: the cloud mints a short-expiry, single-object presigned PUT over the
agent's existing link, so the observatory holds no bucket credential — only its
revocable device token. Downloads are presigned GETs minted by the API against the
requesting customer, after the ownership check.

Until then `thumbnailUrl` is null throughout, which is the contract's own word for
"no thumbnail". A fabricated path would be a broken image in every card.

**The `Collection` table is not the Collection.** `GET /captures` is what the
contract and `CLAUDE.md` mean by a customer's Collection. The `Collection` /
`CollectionCapture` tables hold curated named sets (SOLAR_SYSTEM,
MESSIER_STARTER) that no endpoint reads and nothing writes. They predate the
contract and are left alone.

## What DV-062 wrote down, and what has no writer yet

`AuditCategory` had nine members and one writer: authentication. Everything else the
system did — a session opened, a command minted, a slew refused, MAX_ALT_SAFE changed,
the link dropping — left either nothing behind or only its latest state. DV-062 is the
writers, the two read surfaces the contract already declared, and two schema gaps.

**One recorder, in `packages/db/audit.ts`.** Both services write audit rows, so the
action vocabulary lives in the package they already share rather than in two copies that
drift. There is no update path and no delete path, and `createdAt` is the database's
default with no parameter that could override it — which is what makes "never backdated"
a property rather than a promise. A `detail` key that names a token, secret, password or
credential throws instead of being redacted, because a redacted row hides that a call
site tried.

The writer argument is explicit and has no default. Where the audited thing is
transactional the row joins its transaction, for the same reason `notifyAgent` does: a
row written on another connection commits whether or not the fact it describes did.

| Category | Written when |
| --- | --- |
| `AUTH` | Unchanged. `recordAuthEvent` now goes through the shared recorder. |
| `BOOKING` | A slot is reserved, and released when its payment fails. |
| `MISSION` | A session opens or is revoked; the cloud closes out a mission after an agent restart. |
| `COMMAND` | A command is minted; the agent's verdict is applied. |
| `SAFETY` | The cloud refuses a command, and whenever the safety envelope is recorded. |
| `AGENT_LINK` | The link comes up, and every time it drops. |

`PAYMENT` still has no writer (DV-056). `OBSERVATORY_MODE` and `OPERATOR_OVERRIDE` now
have one: DV-063 writes both.

**Two schema gaps, both of them the contract's own fields going nowhere.**

`AuditEvent` declares `missionId`, and `GET /admin/logs?missionId=` filters on it;
`AuditLog` had only the polymorphic `entityType`/`entityId` pair, which would have made
the one query an operator runs during an incident a scan. It is now a column with an
index, and the foreign key is `SET NULL` — deleting a mission must not delete the account
of what was done to it.

`MissionEvent` declares `failureReason` and `commandId`. `AgentMissionEvent` has carried
both since the contract was written and the cloud discarded both, which left the trail
chronological but not correlated: nothing recorded which nudge produced which
`CENTERING`, and a mission that held and then failed read as though it had only failed.
A correlation to a command this cloud did not mint for this observatory is dropped rather
than written — the transition really happened, only the claim about its cause is one the
cloud cannot support.

**Two read surfaces, both already in the contract.**

`GET /admin/logs` is operator-only and newest first, because the contract calls it "the
primary debugging tool" and the question asked of it is always what just happened. An
unrecognised `category` is a 422 rather than a filter that quietly matches nothing.

`GET /missions/{missionId}/events` is the mission's own trail, oldest first, ordered by
`occurredAt` — the observatory's clock, replayed unchanged after a reconnect. Ordering it
by insert time would file a queue drained after an outage as though everything happened
at once. Someone else's mission is a 404, not a 403.

Both page by keyset, never by offset. An offset page over an append-only table that is
being written to while it is read silently repeats rows.

**Not written: the route-level refusals.** A body that tries to mint its own `sessionId`,
or names `GOTO`, is refused before the domain sees it and leaves no row. Those are
attempts to exceed authority rather than accidents, and they belong with the abuse
controls in DV-115 alongside whatever rate limiting answers them — not bolted to a route
handler here.

**DV-063 does not rebuild `/admin/logs`.** It exists, it is guarded, and it is tested.

## What Milestone S1 found

The first run of the real agent against the real realtime service, on 2026-09-07.

**The agent had never connected.** Python's `isoformat()` writes `+00:00`; the
generated validators accept only `Z`. RFC 3339 permits both, so neither half was
wrong alone — they did not agree, and every message the agent sent was refused at the
parse step. Four merged pull requests and nine hundred passing tests did not catch it,
because the Python suite checks the agent against its own fakes, the TypeScript suite
builds fixtures with `toISOString()`, and nothing had ever run the two halves against
each other. One command ack was stamped in the observatory's local zone.

Fixed by `wire_timestamp` in the agent, and the rule is now stated in the contract's
TIMESTAMPS section rather than left as an accident of the generator. The strictness is
deliberate: one spelling, on a wire where an instant decides when a telescope moves.

**The cloud re-pushed the safety envelope every five seconds.** The reconnect sweep was
wired to every inbound frame rather than to the transition into ONLINE, so each
heartbeat re-read the envelope, the session and the pending commands, and pushed two
messages at an idle observatory. Fixed, and splitting it exposed that ADR-009's slow
fallback timer had never existed — the per-message sweep had been standing in for it,
which meant the fallback disappeared exactly when an agent went quiet.

**What S1 could not prove.** No mount motion and no mission state machine, because
`MAX_ALT_SAFE` is UNMEASURED and both the cloud and the agent independently refuse
every slew, nudges included. That is the safety envelope working. Closing it is DV-034,
attended, against the real optical train.

**What S1 did prove.** The link reaches ONLINE and stays up on heartbeats; a session is
owned over HTTP with real cookies; a nudge is refused by the cloud with
`SAFETY_ENVELOPE_UNMEASURED`; and an `ABORT` minted over HTTP travels API → database →
`NOTIFY` → realtime → WSS → agent → `SimMount` and returns ACCEPTED. The DV-062 audit
trail records all of it, including the three `AGENT_LINK_LOST` rows from the failed
attempts.

## Critical path

DV-003 → DV-020/021/022 → DV-023/025 → DV-026 → DV-057/058 → DV-040 → DV-060 →
**Milestone S1** → DV-034 (where `MAX_ALT_SAFE` is measured) → DV-028/029/030 → DV-036.

DV-040 is on the path because nothing before it made a command reach a device. Until it
landed, every component of the chain existed and the chain did not.

Everything else hangs off that path and must not be scheduled ahead of it.

## What DV-040 wired, and what it deferred

DV-026 built the mission runner and DV-057/058 built the link and the orchestrator,
but nothing joined them: a command minted by the cloud reached the agent's socket and
was dropped. `darkview_agent/supervisor.py` is that join, and `python -m darkview_agent`
is the process that runs it.

**Paid.** `CommandValidator` was constructed nowhere in production code. Both of its
fail-closed arguments are now passed by `build_supervisor`, and each is proved by a test
that fails if the wiring is removed — a unit test of the validator passes either way.

| Argument | What it is now | Proved by |
| --- | --- | --- |
| `pointing` | `MountDriver.status()` altitude and azimuth | `test_a_nudge_is_judged_on_where_it_would_land` |
| `attended` | `AgentConfig.attended`, from local configuration only | `test_the_daylight_lock_answers_to_the_local_attended_flag` |

`MissionRequest.operator_override` was added in the same work. Without it a daylight
GOTO from an attended operator was accepted by the validator and then refused by the
runner a moment later, which would have made the attended terrestrial testing DV-034 and
DV-035 depend on impossible.

**Deferred, and refused loudly meanwhile.** Three command types the contract defines have
no implementation behind them. The supervisor refuses each with `DEVICE_UNAVAILABLE` and a
detail naming the issue that owes it, because an ACCEPTED ack for a command nothing
performs tells the customer the telescope did something it did not do.

| Command | Owed to | What is missing |
| --- | --- | --- |
| `CAPTURE` | DV-033, DV-061 | The live stack, the upload and somewhere to keep the result |
| `FOCUS` | DV-031 | The focuser driver and the autofocus routine |
| `SET_PROFILE` | DV-033 | The table mapping an imaging profile to exposure, gain and ROI |

`CAPTURE` is a `ClientCommandType`. Until DV-033 lands, the Capture control has nothing
behind it and the web UI must not offer it as though it did.

**A question DV-028 must answer, not copy.** The supervisor performs a nudge as an
absolute alt/az slew to the projected position. That is exactly a nudge against
`SimMount`. Against a tracking Celestron it is a real question — whether the offset
belongs on the target or on the axes — and DV-028 has to decide it from the mount's
behaviour rather than from the line the simulator made look correct.

**Since paid by DV-027.** The audit log, the idempotency set, session ownership
with its spent nudge allowance, and the measured safety envelope now survive a
restart. A mission does not: the agent parks and reports it through
`AgentHello.resumeMissionId`, because coming back with a mission id and no state
machine is not enough to know where a telescope is pointing.

**The mission profile is still the runner's defaults.** A `GotoPayload` carries an
`opticalConfig` and an `imagingProfile`; nothing yet maps either to an exposure, a gain or
a frame count, so a mission runs on `DEFAULT_EXPOSURE_MILLISECONDS`, `DEFAULT_GAIN` and
`DEFAULT_CAPTURE_FRAMES`. DV-033 replaces them with measured figures per profile.

## Blocking external dependencies

These are not engineering work, and none of them can be compressed by working harder.

| | Blocks |
| --- | --- |
| Installation site chosen, with **written** permission | DV-034 and every real-hardware issue |
| Site compass survey | DV-034, DV-059 |
| **`MAX_ALT_SAFE` measured** from the assembled optical train | DV-034 and every issue that permits a slew |
| Payment provider merchant onboarding, with the provider's own webhook and signature documentation | DV-056 |
| S3-compatible object storage: an account, a private bucket and credentials | the rest of DV-061, DV-033 |
| Hardware order placement and arrival dates | DV-034, DV-035 |

**`MAX_ALT_SAFE` is deliberately `null` in the contract.**
`SafetyEnvelopeConfig.maxAltitudeDegrees` is nullable, has no default, and `null` means
UNMEASURED — in which state both the API and the agent refuse every slew with
`SAFETY_ENVELOPE_UNMEASURED`. Provisional values printed in earlier planning documents
are not values. No agent may ship one, seed one, or use one as a test fixture outside a
clearly-named fake.

## What the slot exclusion constraint closed

The first of DV-066's three parts, and the only one that is a safety property rather
than a product one. No contract change, no API surface: a migration, the guard that
reads its refusal, and the tests that hold both.

```sql
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_held_slot_exclusion" EXCLUDE USING gist (
  "observatoryId" WITH =,
  tsrange("slotStartAt", "slotStartAt" + make_interval(mins => "durationMinutes")) WITH &&
) WHERE ("status" IN ('PENDING_PAYMENT', 'CONFIRMED'));
```

**Exclusivity is still the database's rule and still nothing else's.** DV-055 put it
there so application code could not quietly weaken it, and this widens what "taken"
means from an equal start instant to an overlapping interval without moving it. The
test that proves it is the one DV-055 established: drop the constraint, watch a named
test double-book at a concurrency of twenty, restore it. `reserveSlot` needed no new
logic — which is the point of having put the rule where it is.

**`tsrange`, not ADR-015's `tstzrange`.** `slotStartAt` is `TIMESTAMP(3) WITHOUT TIME
ZONE`; casting it inside an index expression reads the session `TimeZone` and
PostgreSQL refuses to index a non-immutable expression. Prisma writes UTC in that
column, so the two forms mean the same thing here. The record carries a dated
correction, along with `make_interval` over a text-concatenated interval literal for
the same immutability reason.

**The one thing that had to change, and would not have been noticed.** Prisma reports
an exclusion violation as **`P2039`**, its opaque "unknown database error" bucket —
not `P2002`. `isUniqueViolation` checked `P2002`, so every customer who lost a race
would have been handed a 500 instead of a 409, and the losing insert would have been
rethrown from inside the transaction. The guard now reads the PostgreSQL SQLSTATE
underneath (`23P01`, or `23505` for the idempotency-key index), because Prisma's code
for this case is undocumented and the SQLSTATE is a standard. Verified by restoring
the `P2002`-only check and watching four named tests fail.

**And the one that was noticed only by running the race enough times.** An
exclusion constraint deadlocks where a unique index does not. A unique btree checks
for a duplicate before it writes, under a page lock, so the second inserter simply
waits for the first. An exclusion constraint writes its index entry first and checks
after: two reservations of overlapping time each write, each find the other's
uncommitted row, and each wait on the other until PostgreSQL aborts one with
**`40P01`**. Nothing double-books — the constraint is sound — but the victim was
handed a 500. Measured at a few races in a hundred, which is why the existing
two-request test passed most runs and the defect reached a pushed branch.

The reservation transaction now reruns on `40P01`, up to five attempts. That is the
correct resolution rather than a hopeful one: by the time the victim is told, the
survivor is no longer waiting on it, so a rerun either meets a committed overlap and
gets the clean `23P01` it was owed, or finds the survivor failed and takes the slot.
Reporting the deadlock itself as "taken" would be a guess about the second case.

The test races two customers until PostgreSQL has actually deadlocked — observed, not
assumed — and asserts every loser, the victim included, got a 409. It stops at the
first deadlock because each costs a full `deadlock_timeout` (one second by default),
with a ceiling of 200 rounds. With the retry removed it failed 10 runs in 10; with it,
it passed 10 in 10, and every one of those runs saw a real deadlock.

**A `CHECK ("durationMinutes" > 0)` landed with it.** `tsrange(t, t)` is the empty
range and the empty range overlaps nothing, not even itself, so a zero-duration
booking would sit outside the exclusivity rule while still holding a telescope. A
negative duration raises, which is loud and therefore harmless; zero is the silent
case, and it is closed in the database for the same reason the exclusion is.

**`btree_gist` is not a trusted extension**, so the migration's `CREATE EXTENSION`
needs a superuser on PostgreSQL 13 and later. CI's postgres container is one. A
managed production database may not be; the runbook says to have an administrator
install it before the first deploy that carries this migration.

**The restore drill asserts the constraint, not just its index.** An exclusion
constraint's operators live in `pg_constraint.conexclop`, which `indexdef` does not
render — a dump that brought back the GiST index without them would restore a table
whose constraint list looks right and double-books. The drill now reads
`pg_get_constraintdef` and holds the equality, the overlap and the WHERE clause.

**Still open in DV-066:** the observatory dimension itself — `observatoryId` on
`Slot`, `SlotList`, `Booking` and `CreateBookingRequest`, the `observatoryId` query
parameter on `GET /slots`, a public endpoint listing bookable observatories, and the
two `findFirst` calls in `slots.ts` and `reserve.ts`. Nothing sells a second slot
length yet, and nothing may until that lands.
