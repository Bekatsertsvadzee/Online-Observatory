# Darkview safety model

This document states what stops the telescope destroying itself, where each rule is
enforced, and what is deliberately not overridable. It describes the system as built.
Where something is designed but not yet wired, it says so and names the issue that owes
it — a safety document that overstates its coverage is worse than none.

`docs/security.md` covers accounts, sessions and the browser boundary. This covers the
mount, the camera and the sky.

## 1. The shape of the argument

Two independent implementations must both agree before anything moves.

```
customer intent
   │
   ▼
cloud     apps/api/src/lib/safety/envelope.ts     validate  ─── refuse ──▶ 4xx, nothing minted
   │      mint CommandEnvelope, sign, record
   ▼
agent     safety/envelope.py                      validate AGAIN ── refuse ──▶ REJECTED ack
   │
   ▼
device
```

**The duplication is the feature.** `apps/api/src/lib/safety/envelope.ts` and
`agent/darkview_agent/safety/envelope.py` are two separate implementations of the same
rules, and they must never be merged into shared code. Two implementations that agree are
evidence; one implementation called twice is a single point of failure wearing a safety
label — a bug written once would be enforced identically on both sides and caught by
neither.

What has to stay in step is the **decision**, not the code: the same rule order, and the
same `CommandRejectionReason` for the same condition.
`apps/api/src/lib/safety/sun-exclusion-agreement.test.ts` is what proves the one
calculation both sides derive independently still agrees.

A `REJECTED` ack carrying a `SAFETY_` reason after the cloud approved the command is not
a bug. It is the second check doing its job, and it is recorded rather than smoothed over.

## 2. UNMEASURED is the state every observatory ships in

`SafetyEnvelopeConfig.maxAltitudeDegrees` is `MAX_ALT_SAFE`: the altitude beyond which the
rear of the camera train meets the fork base. It is nullable, has no default anywhere in
the stack, and **`null` means UNMEASURED**.

While it is null, both the cloud and the agent refuse every slew with
`SAFETY_ENVELOPE_UNMEASURED`. Not a warning, not a degraded mode — a refusal, from both
sides, independently.

There is no third state. There is no fallback value. Planning documents from before this
repository printed a provisional figure; **that number is not a value** and must never be
shipped, seeded, defaulted, or used as a test fixture outside a clearly-named fake.

Recording a measurement requires its provenance. `setSafetyEnvelope` refuses a
`maxAltitudeDegrees` that arrives without `maxAltitudeMeasuredAt` and
`maxAltitudeMeasuredBy` — a number with no measurer is somebody's guess, and a guess here
is how an optical train meets a fork arm.

**Site coordinates fail closed the same way.** `DARKVIEW_AGENT_SITE_LATITUDE` and
`DARKVIEW_AGENT_SITE_LONGITUDE` must be set together or not at all. Without them the Sun's
position cannot be computed, so the envelope refuses every slew rather than assuming the
Sun is somewhere convenient. Half a position is worse than none: it would pair a real
latitude with a default longitude and return a confident, wrong answer.

## 3. The rules, in the order they are applied

From `evaluate_pointing`. The order matters: the reason returned is the most important
thing wrong, not whichever rule happened to be tested last.

| # | Rule | Refusal | Overridable |
| --- | --- | --- | --- |
| 1 | `MAX_ALT_SAFE` is measured | `SAFETY_ENVELOPE_UNMEASURED` | no |
| 2 | Site coordinates are known | `SAFETY_SUN_EXCLUSION` | no |
| 3 | Angular separation from the Sun ≥ `sunExclusionDegrees` | `SAFETY_SUN_EXCLUSION` | **never, by anything** |
| 4 | Sun below `daylightLockSunAltitudeDegrees` | `SAFETY_DAYLIGHT_LOCK` | operator, attended only |
| 5 | Altitude within `minAltitudeDegrees`…`MAX_ALT_SAFE` | `SAFETY_BELOW_MIN_ALTITUDE` / `SAFETY_ABOVE_MAX_ALTITUDE` | no |
| 6 | Altitude above the surveyed horizon at this bearing | `SAFETY_HORIZON_MASK` | no |
| 7 | Bearing outside every cable-wrap sector | `SAFETY_FORBIDDEN_AZIMUTH` | no |

**Rule 3 is absolute.** No flag, configuration value, operator override or admin role
widens or disables the Sun exclusion. The `operator_override` parameter exists for
attended terrestrial testing and reaches only rule 4 — and by the time it is consulted,
rule 3 has already been enforced.

Nudges are judged separately by `evaluate_nudge`: a negative step is refused, a step
larger than `nudgeRateDegreesPerSecond` is refused, and a cumulative offset that would
exceed `nudgeMaxDegrees` is refused. Only discrete bounded steps are ever exposed to a
customer; there is no continuous slew control, so there is no rate to police beyond the
step itself.

A nudge is then *also* checked against rules 1–7 on its **projected** position, not its
step size. A step within every relative limit can still land outside the envelope, because
`nudgeMaxDegrees` is measured from the booked target while `MAX_ALT_SAFE` is measured from
the mount.

## 4. PARK and ABORT are never refused on envelope grounds

`PARK` and `ABORT` skip the safety-envelope check. Park is the answer to every unresolved
condition and moves the mount to a known-safe position by definition; refusing it because
the envelope is unmeasured would strand a telescope in exactly the situation Park exists
to resolve.

They are still fully authorised. An unauthorised Park is still unauthorised — structure,
idempotency, expiry and session ownership all apply.

## 5. The command envelope

Every command crossing the boundary is a `CommandEnvelope` minted and signed by the cloud.
**The client never mints one.** It submits bounded intent; `commandId`, `sessionId`,
`userId`, `issuedAt` and `expiresAt` are all set by the cloud.

The agent re-checks all of it, in this order (`command/validator.py`):

1. **Structure** — a payload that will not parse cannot be reasoned about.
2. **Idempotency** — a repeated `commandId` never touches the device twice. Decisions are
   kept in the local state store, so a command retried across a restart is still refused.
3. **Expiry** — a command queued before a reconnect must not fire after it.
4. **Authorisation** — session, then user, then mission.
5. **Payload kind** — the envelope's type and its payload must agree.
6. **Safety envelope** — the last word, and the only step that inspects the sky.

## 6. The watchdog

`safety/watchdog.py`. Heartbeat loss, device fault and operator abort all converge on one
terminal sequence: **stop capture, abort motion, Park.**

It runs on its own thread, and that is the entire point. Everything else in the agent is a
polled state machine driven by the main loop — which is fine until the main loop is the
thing that has gone wrong: blocked on a socket, wedged in a driver call, stuck behind a
slow disk. A watchdog living in that loop would be asleep in exactly the situation it
exists for.

Two thresholds, both from the envelope:

| Threshold | What happens |
| --- | --- |
| `heartbeatLossSeconds` | Capture stops. The mount keeps tracking. |
| `linkDeadSeconds` | The mount parks. |

The gap between them is deliberate. A brief network stall must not cost a customer their
session; a sustained one must not leave a telescope tracking unattended.

**It never depends on the cloud being reachable.** The timers run from start-up, not from
first contact, so an observatory that booted into a network outage still parks. Until an
envelope arrives it uses deliberately short fallbacks — 15 s and 60 s — because an agent
that does not yet know its own thresholds should be more cautious, not less.

Three further properties worth knowing:

- **The event is written before anything is touched.** If the process dies mid-action the
  record still says what it was about to do and why. That is the difference between a
  diagnosable incident and a telescope found in an unexplained position.
- **All device access is taken under a shared lock.** The drivers are not thread-safe and
  the main loop touches the same ones; a Park racing a slew is a real hazard, not a
  theoretical one.
- **Abort and Park are both attempted even if the first fails.** A mount that will not
  abort might still park, and a parked mount is the outcome that matters. A park failure
  is recorded rather than swallowed.

A watchdog that dies on an unexpected error is worse than no watchdog, because it looks
like one. The thread logs and continues.

## 7. Real hardware requires two independent decisions

`config.py` refuses to start when `DARKVIEW_AGENT_DRIVER_MODE=REAL` is set without
`DARKVIEW_AGENT_ATTENDED`. Neither alone is enough, and there is no code path that reaches
`DriverMode.REAL` without both.

**The simulator is the default. Always.** No autonomous, scheduled or background session
may command the real mount or camera. Real-hardware mode is an explicit, attended operator
action taken outside the normal test workflow.

The agent also refuses to start without an observatory id, a cloud URL and a device token.
An agent that cannot reach the cloud cannot be told to stop, and a telescope on a rooftop
with no way to be reached is the situation to avoid rather than to tolerate.

## 8. The network posture

The observatory accepts **no inbound connection** from the internet or the LAN. It opens
no listening port and has no reachable address. It dials out over authenticated WSS,
keeps a heartbeat, and reconnects with exponential backoff.

One exception, by design: the ASCOM Remote / Alpaca bridge listens on `127.0.0.1` only,
for traffic between the agent and the local mount driver on the same machine. It must
never bind `0.0.0.0`, never be port-forwarded, and never be reachable from another host.

No browser or mobile client may address the mount or the camera. The live view is served
by the cloud from the cloud's own memory (ADR-011); nothing in it gives anybody an address
for the mount, the camera or the mini-PC.

## 9. What is designed but not yet wired

Stated plainly, because a safety document that implies coverage it does not have is the
failure it exists to prevent.

| Gap | Consequence today | Owed by |
| --- | --- | --- |
| **No operator emergency-park control.** `Watchdog.operator_abort` has no caller outside an `ABORT` command envelope. | An operator's emergency stop is: send `ABORT`/`PARK` through the mission command route as the session owner, or stop the agent process (which parks on shutdown), or wait out `linkDeadSeconds`. There is no button. | DV-063 |
| **`Watchdog.weather_unsafe` has no caller.** Nothing reads weather and nothing raises the trigger. | `WEATHER_HOLD` is reachable only by an operator moving the mission by hand. | DV-039 |
| **`MAX_ALT_SAFE` is unmeasured, and no hardware exists.** | Every slew is refused by both cloud and agent. This is the system working. | DV-034 |
| **Nothing has run against a real mount or camera.** Every property above is verified against `SimMount` and `SimCamera`. | The rules are proven; their behaviour against real driver faults and real timing is not. | DV-034 … DV-038 |

The last row is the important one. Nothing in this document should be read as evidence
about physical hardware. It is evidence about the rules.

## 10. Where the code is

| Concern | File |
| --- | --- |
| Agent envelope (pure functions) | `agent/darkview_agent/safety/envelope.py` |
| Cloud envelope (independent second implementation) | `apps/api/src/lib/safety/envelope.ts` |
| Sun position and separation | `agent/darkview_agent/safety/sun.py`, `apps/api/src/lib/ephemeris/engine.ts` |
| Command re-validation | `agent/darkview_agent/command/validator.py` |
| Watchdog | `agent/darkview_agent/safety/watchdog.py` |
| Start-up refusals | `agent/darkview_agent/config.py`, `agent/darkview_agent/__main__.py` |
| Recording a measured envelope | `apps/api/src/features/admin/safety-envelope.ts` |
| Local state that survives a restart | `agent/darkview_agent/state/store.py` (ADR-010) |

Operational procedure — starting, stopping, qualifying, and what to do when something goes
wrong — is `docs/RUNBOOK.md`.
