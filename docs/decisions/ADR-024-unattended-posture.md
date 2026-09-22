# ADR-024 — The agent's unattended posture

- **Date:** 2026-09-22
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Approved:** 2026-09-22, with the answers recorded at the end
- **Issue:** DV-126 (#137)
- **Relates to:** `ADR-013` (partner observatories), `ADR-023` (Queued Capture, draft),
  `ADR-010` (agent local state store), `ADR-020` (device token issuance), DV-039 (weather
  hold enforced by the agent)
- **Blocks:** unattended real-hardware operation on any node — partner under ADR-013, or
  first-party under ADR-023
- **Buildable:** now, against `SimMount` and `SimCamera`, except the sky sensor (§6).

## Context

ADR-013 says an `APPROVED` partner node may accept customer commands while its owner is
absent. The agent as built cannot do that without lying to itself.

- `load_config` refuses `DARKVIEW_AGENT_DRIVER_MODE=REAL` unless `DARKVIEW_AGENT_ATTENDED`
  is also set, and `read_env_file` refuses a file that carries either
  (`agent/darkview_agent/config.py`). Partner setup deliberately writes neither
  (`agent/darkview_agent/setup.py`).
- The attended flag does two jobs. It lets the agent start on real hardware, **and** it is
  the local half of the daylight-lock override (`CommandValidator.operator_override`),
  which exists for an operator standing at the instrument.
- The agent never sees a node's `NetworkNodeApprovalStatus`. `APPROVED` is enforced only by
  the cloud's bookability filter (`apps/api/src/features/booking/observatories.ts`).

So an approved partner owner who wants to leave either never runs real hardware, which
contradicts ADR-013, or starts with the attended flag set and walks away. That flag is then
false, and the daylight override is armed at an instrument nobody is standing beside.

Nothing is exposed today: no partner reaches `APPROVED` on real hardware before DV-124.
ADR-023 needs the same thing for first-party Queued Capture. One design serves both.

## Decision

### 1. A third posture, which only removes

The agent runs in exactly one posture, reported to the cloud:

| Posture | Drivers | Who is at the instrument | How it is entered |
| --- | --- | --- | --- |
| `SIMULATED` | simulated | nobody needs to be | the default |
| `ATTENDED` | real | an operator, present | `DRIVER_MODE=REAL` and `ATTENDED` in the process environment, as today |
| `UNATTENDED` | real | nobody | armed from `ATTENDED`, by a local act (§2) |
| `DISARMED` | real | nobody | the latch (§4) |

`UNATTENDED` differs from `ATTENDED` in exactly one validator rule:

- **`operator_override` is always false.** The daylight lock cannot be lifted, whatever
  the cloud's `issuedByOperatorId` says.

Every other rule applies unchanged: envelope, horizon mask, Sun avoidance, session
ownership, expiry, duplicate rejection, nudge budget, weather hold, emergency Park.

`NUDGE` is **not** removed by the posture. A partner node's live customer is present, on
the feed, and a nudge within the budget is judged where it would land — the same check an
attended session gets. What removes `NUDGE` for ADR-023's queued missions is the absence of
a human session owner, which is the scheduler's role in the cloud, not the agent's posture.
This corrects the ADR-023 draft (#136) and issue #137, which both said the posture refuses
`NUDGE`.

`DISARMED` refuses everything but `PARK` and `ABORT`, with a new rejection reason,
`UNATTENDED_DISARMED`. It is the posture a real-hardware agent is in when it was
unattended and something went wrong.

### 2. Arming is a local act, from an attended agent, for this process only

Unattended operation is entered, never started into.

1. An operator (for a partner node, the owner — the only person there) starts the agent
   on real hardware exactly as today: `DRIVER_MODE=REAL` and `ATTENDED` in the process
   environment, in person.
2. With the agent running, they run `python -m darkview_agent arm-unattended` on the same
   machine. It writes an arming row into the ADR-010 local state store: who (an operator
   name they type), when, and the **run id** of the agent process it arms.
3. The running agent reads the row, checks the run id is its own, audits the arming, and
   moves `ATTENDED → UNATTENDED`. The operator leaves.

Three properties are deliberate:

- **No new way to start on real hardware.** `FILE_FORBIDDEN_SETTINGS` and the
  `load_config` rule stay exactly as they are. Nothing a file or a service unit can carry
  selects `UNATTENDED`.
- **An arming dies with its process.** The row names a run id, and a restarted agent has a
  new one. A power cut, a crash or a Windows update ends unattended operation: a restart
  without a person present cannot re-select real hardware at all, and a restart with one
  present comes back `ATTENDED`. The agent cannot prove the mount survived whatever
  restarted it — a power loss can cost it its alignment — so the answer to a restart is
  somebody looking.
- **The store is the channel, not a socket.** The observatory accepts no inbound
  connection, including from its own LAN. The CLI and the agent share the SQLite file the
  agent already owns, and nothing listens.

`python -m darkview_agent disarm` writes the opposite row and is always permitted.

### 3. Both sides must agree; the cloud is trusted only to make things safer

The agent accepts a customer or scheduler command in `UNATTENDED` only because its own
arming says so. The cloud sends one only because its own approval says so — `APPROVED` for
a partner, `UNATTENDED_APPROVED` for ADR-023. Neither side can arm the other.

The cloud may **disarm** the agent, never arm it. A new `CLOUD_OPERATING_UPDATE` carries
the node's approval status down the link, on the pattern of `CLOUD_WEATHER_UPDATE`: the
relay reads the row, the notification carries no payload, and the reconnect sweep sends it
beside the envelope and the weather. A status that no longer permits unattended operation
— `SUSPENDED`, `DRAFT`, anything but approval — moves the agent to `DISARMED`. An approval
arriving on a disarmed agent does nothing.

That is the rule DV-039 already follows for weather: a message from the cloud can close
the observatory, and nothing from the cloud can open it. It is what keeps the cloud's
compromise from becoming the mount's.

Revoking the device token (ADR-020) stays the operator's one-row emergency stop. A revoked
agent loses the link, the watchdog Parks it, and the latch below holds after the link is
gone.

### 4. The latch

An `UNATTENDED` agent moves to `DISARMED`, audits why, and Parks when any of these happen:

- a mission enters `HARDWARE_ERROR`, or any device reports a fault
- a Park fails or times out
- the cloud link stays lost past a **sustained-loss limit**, longer than the watchdog's
  deadline. A shorter outage Parks the mount through the watchdog, as today, and does not
  disarm: once the link returns, the mount is Parked and the agent is still armed. The limit
  is measured during DV-037's failure drills; until then it is not set, and no partner runs
  unattended without it.
- a `CLOUD_OPERATING_UPDATE` no longer permits unattended operation
- a local `disarm`
- sky-sensor readings go stale (§6)

`DISARMED` is persisted in the local store under the same run id, so a disarmed agent that
reconnects is still disarmed. **Nothing returns it to `UNATTENDED` except a new local
arming**, and arming is accepted only from `ATTENDED` (§2): the operator restarts the agent
attended, looks, and arms again. Not a reconnect, not a cloud message, not the fault
clearing.

### 5. The cloud mirrors the posture

`AgentHello` and `ObservatoryTelemetry` gain `posture`, beside the existing `mode`. The
cloud stores the last reported posture on the observatory and reads it in two places:

- **Bookability.** A partner node is offered for unattended hours only while `APPROVED`
  **and** reporting `UNATTENDED` or `ATTENDED`. A node reporting `DISARMED` stops being
  offered. What happens to a `CONFIRMED` booking on a node that disarms is DV-111's refund
  engine, and is recorded as a consequence, not decided here.
- **The operator console** shows the posture and the disarm reason, so the operator knows
  whether to call the owner.

`ObservatoryMode` (`SIMULATED | REAL`) is unchanged. Posture refines `REAL`; it does not
replace the mode every client already reads.

### 6. Weather

Phase 1 has no sky sensor, and `POST /admin/observatory/weather-hold` is the only thing
that can call the weather unsafe (DV-039). On an unattended node, nobody is at the window
to do it.

**An unattended node, partner or first-party, must have a fitted sky sensor**, whose
readings reach the agent as `WeatherState` with `source: SENSOR`. Stale readings are a
weather hold and a latch trigger (§4). This is the requirement ADR-023 §3 places on
first-party nodes, applied to partners too: rain does not check who owns the telescope.

No sensor is chosen and none is fitted. Arming (§2) is therefore refused on real hardware
until one is, and the staleness limit is measured, not chosen here. Everything else in this
record is buildable before then.

## Implementation, once approved

**Contract** (`contracts/openapi.yaml`, regenerated with `npm run contracts:generate`):

- `AgentPosture` enum: `SIMULATED, ATTENDED, UNATTENDED, DISARMED`
- `AgentHello.posture` and `ObservatoryTelemetry.posture`, required
- `CloudOperatingUpdate` in `CloudToAgentMessage`, carrying the node's approval status
- `CommandRejectionReason.UNATTENDED_DISARMED`
- A `DisarmReason` enum for the audit and the console

**Agent** (`agent/darkview_agent/`):

- `config.py` — unchanged. That is the point.
- `state/store.py` — an arming table: run id, posture, operator name, reason, time.
  Append-only like the audit log.
- `__main__.py` — `arm-unattended` and `disarm` subcommands, beside `setup`
- `command/validator.py` — `operator_override` reads the posture, not the raw attended
  flag; `DISARMED` refuses all but `PARK` and `ABORT`
- `supervisor.py` — polls the arming table, owns the posture, applies the latch, handles
  `CLOUD_OPERATING_UPDATE`, reports posture in the hello and the telemetry

**Cloud** (`apps/api`, `apps/realtime`, `packages/db/prisma/schema.prisma`):

- The observatory's last reported posture and disarm reason, written by the agent link
- The relay's `OPERATING` notification kind and its place in the reconnect sweep
- The bookability filter reads the posture
- The console shows it

**Tests**, all on the simulator:

- The arming CLI refuses unless the agent is `ATTENDED`, and refuses a run id not its own
- A restarted agent never comes back `UNATTENDED`
- `UNATTENDED` refuses the daylight override when the cloud claims an operator
- Each latch trigger moves the agent to `DISARMED`, Parks, and survives a reconnect
- An approval from the cloud never re-arms; a suspension from the cloud always disarms
- A `DISARMED` node is not bookable

## Why this route

- **It adds no path onto real hardware.** Every unattended run begins as an attended one,
  started the way the first-party rule already requires. The unattended posture is a
  narrowing of a state someone was present for, not a new door.
- **It ends at the next surprise.** An arming that dies with its process and latches off on
  every fault means the default answer to anything unexpected is Parked and waiting for a
  person, which is the answer the attended rule gave.
- **It keeps the double validation honest.** The agent's decision to move rests on its own
  record; the cloud can only take that decision away.
- **It is one mechanism for two ADRs.** Partners and first-party Queued Capture differ in
  what the cloud approves, not in what the agent enforces.

## Alternatives considered

- **Start on real hardware from a service unit when approved.** Rejected: it is the
  unattended start `FILE_FORBIDDEN_SETTINGS` exists to prevent, and it makes a reboot
  re-arm an instrument nobody has looked at since the thing that rebooted it.
- **Arm from the cloud** — the operator approves in the console and the agent follows.
  Rejected: it makes the approval a cloud claim the agent must trust, which is the trust
  `operator_override` withholds today.
- **Leave ADR-013 as it is and let owners set the attended flag.** Rejected: a false flag,
  and the daylight override armed with nobody present.
- **Arming that survives restarts.** Rejected for now; revisit if restarts prove common
  and the mount is shown to keep its alignment through them (below).

## Consequences

- **ADR-013 is amended**, in the commit that approves this record: an unattended partner
  runs in the posture this record defines, and its condition table gains §6's sky sensor.
  `CLAUDE.md` and `docs/ENGINEERING.md` § Hardware safety are amended to match.
- **The ADR-023 draft is corrected** to cite this record for §1 and §3, and to take
  `NUDGE`'s removal from the scheduler's role rather than from the posture.
- **Every restart on an unattended node costs a visit.** For a partner that is the owner
  walking to their telescope; for first-party it is Darkview's operator.
- **A contract change**, made here and released, then copied to `darkview-clients`.
- **A disarm strands confirmed bookings**, and DV-111 needs a rule for them before any
  partner is sold unattended hours.

## Answers, 2026-09-22

The maintainer approved this record with these answers to its open questions.

1. **`NUDGE` stays available to a live customer on an unattended partner node.** The
   customer is on the feed, and the nudge budget and the landing check still apply.
2. **An unattended partner needs a sky sensor**, as a first-party node does under ADR-023.
   §6 is written accordingly.
3. **Every restart costing a visit is accepted for now**, for partners as for first-party.
   Revisited with evidence from real partner nodes, as below.
4. **A brief, recovered link outage does not require a visit.** The watchdog Parks; only a
   loss past the sustained-loss limit disarms. §4 is written accordingly.
5. **A shell on the observatory machine is sufficient to arm in Phase 1.** It is the trust
   `DARKVIEW_AGENT_ATTENDED` already rests on. A physical act is added if the audit ever
   shows an arming by somebody who was not there.

## When this would be revisited

If restarts or brief link outages prove frequent enough that every one costing a visit
makes unattended operation useless, §2 and §4 are revisited — with evidence from the
attended runs about what a restart does to the mount, not before.

## Correction, 2026-09-22 — where the posture travels

§5 and the implementation section said the posture rides on `AgentHello` and
`ObservatoryTelemetry`. The agent never sends `ObservatoryTelemetry`: the
`AGENT_STATE_DELTA` that carries it has a cloud-side handler and no sender, so a disarm
would have reached the cloud only at the next reconnect.

The maintainer chose, on 2026-09-22, to carry it on `AgentHello` and `AgentHeartbeat`
instead. The heartbeat is sent every five seconds, so a disarm reaches the cloud within
one interval, with no new message type. `ObservatoryTelemetry` is unchanged.

Two smaller things the build settled:

- **The operator sees the posture on `NetworkNode`**, as `agentPosture` and
  `agentDisarmReason`. `OperatorObservatoryState` is assembled from telemetry the agent
  does not yet send, so it could not have shown it.
- **The simulator can be armed; real drivers cannot.** A process starts `ATTENDED`
  whenever it was started with the attended flag, simulated or not, which is what lets
  every rule above be tested without hardware. On real drivers arming is refused until a
  sky sensor is fitted (§6).
