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
DV-027 local state store         DV-059 cloud safety
DV-026 mission runner (sim)      DV-062 audit log
DV-040 supervisor + run loop     DV-060 mission channel
```

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
| Hardware order placement and arrival dates | DV-034, DV-035 |

**`MAX_ALT_SAFE` is deliberately `null` in the contract.**
`SafetyEnvelopeConfig.maxAltitudeDegrees` is nullable, has no default, and `null` means
UNMEASURED — in which state both the API and the agent refuse every slew with
`SAFETY_ENVELOPE_UNMEASURED`. Provisional values printed in earlier planning documents
are not values. No agent may ship one, seed one, or use one as a test fixture outside a
clearly-named fake.
