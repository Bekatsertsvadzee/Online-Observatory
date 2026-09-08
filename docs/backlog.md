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
DV-112, DV-115.

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
