# Darkview — system architecture

Companion to `CLAUDE.md`, which governs. This describes *how* the system is put together;
`CLAUDE.md` decides *what* it must be.

## 1. The shape

```
  browser / mobile
        │  HTTPS + WSS          (clients never address a device)
        ▼
  Darkview cloud
    ├── apps/web        Next.js — public site, dashboard, live room, admin
    ├── API + Postgres  bookings, missions, targets, captures, audit
    └── apps/realtime   one long-lived WebSocket service
        ▲
        │  authenticated OUTBOUND WSS  (the observatory dials out)
        │
  Observatory Agent  (Python 3.12, on the observatory mini-PC)
    ├── Alpaca HTTP over 127.0.0.1  ──▶  ASCOM Remote / CPWI  ──▶  NexStar 6SE
    └── ZWO ASI SDK                 ──▶  ASI585MC
```

**The observatory accepts no inbound connection, from the internet or the LAN.** It dials
out, keeps a heartbeat, reconnects on loss, and re-validates every command it receives.

One exception by design: the ASCOM Remote / Alpaca bridge listens on `127.0.0.1` only, for
traffic between the agent and the mount driver on the same machine. It must never bind
`0.0.0.0`, never be port-forwarded, never be reachable from another host.

## 2. Why the realtime service is separate

The observatory socket is long-lived. A serverless function cannot hold it, so
`apps/realtime` is a small always-on Node service that owns exactly two things: the agent
link, and the fan-out to session participants.

It is deliberately small. It holds no business rules. The orchestrator decides; realtime
transports.

## 3. Command flow, and why it is validated twice

```
client intent  ──▶  cloud: authorise, mint CommandEnvelope, pre-validate safety
               ──▶  realtime: relay to the agent that owns this mission
               ──▶  agent: validate AGAIN, independently
               ──▶  device, or refusal
```

**The client never mints a `CommandEnvelope`.** It submits bounded intent;
`commandId`, `sessionId`, `userId`, `issuedAt` and `expiresAt` are all set by the cloud.

The agent independently enforces, without trusting the cloud:

- idempotent by `commandId` — a repeat is ignored
- rejected after `expiresAt`
- rejected if `sessionId` is not the current session owner
- rejected if `missionId` is not the mission it currently holds
- rejected if the safety envelope refuses it, **even when the cloud approved**

The last line is the point. A cloud-approved command that fails local safety is refused.
Two independent implementations of the same rules mean a bug in one does not reach the
mount.

## 4. Devices are interfaces, and the simulator is the default

`MountDriver` → `SimMount` (default) · `AlpacaMount`
`CameraDriver` → `SimCamera` (default) · `ZwoCamera`

Roughly 60% of Phase 1 is built and tested against the simulators. When hardware arrives
the implementation is swapped behind the interface. **If that swap is hard, the design was
wrong.**

Mount control is Alpaca HTTP rather than in-process COM specifically so it is
network-shaped, mockable, and testable from pytest without Windows COM registration.

## 5. The mission state machine

Authoritative in ADR-004 and generated into all three languages from the contract.

```
REQUESTED → SCHEDULED → PREPARING → SLEWING → VERIFYING → CENTERING
          → OBSERVING → CAPTURING → PROCESSING → COMPLETE
```

`VERIFYING` is the ASTAP plate solve. `CENTERING` applies the solved offset and re-slews,
bounded to **three** iterations. Any state may enter `WEATHER_HOLD`, `NOT_VISIBLE`,
`HARDWARE_ERROR`, `CANCELLED` or `FAILED`, and **every path out of a failure or hold state
ends at Park.**

One active mission at a time. One active session owner at a time.

## 6. Safety

Enforced in the agent, independently of the cloud:

altitude envelope · horizon mask · Sun avoidance · session ownership · command expiry ·
duplicate rejection · emergency Park.

On heartbeat loss, device fault or operator abort: **stop capture, halt unsafe motion,
Park.**

`MAX_ALT_SAFE` is measured from the assembled optical train (DV-034). Until then
`SafetyEnvelopeConfig.maxAltitudeDegrees` is `null`, meaning UNMEASURED, and both cloud and
agent refuse every slew with `SAFETY_ENVELOPE_UNMEASURED`.

`HORIZON_MASK` comes from a compass survey at the actual installation site (ADR-005:
Tbilisi rooftop). A survey from anywhere else is not valid for this site.

## 7. Observers do not exist to the agent

The Observer Pack (ADR-007) fans out in the cloud. **The Observatory Agent never learns an
observer exists**, so observer count cannot affect mount safety, command validation or
session ownership. An observer socket has no command path at all.

If an observer feature appears to require an agent change, it is wrong and stops.

## 8. Contracts

`contracts/openapi.yaml` is the single source of truth. TypeScript and Zod generate to
`packages/contracts/generated`; Pydantic to `agent/contracts/models.py`. `contracts:check`
fails CI on drift.

No hand-written duplicate of a shared type exists in any language. Zod is generated from
the schema, never written as a competing definition.

**Wire format is camelCase.** Pydantic models are snake_case with aliases, so the agent must
serialise with `by_alias=True`; `model_dump_json()` without it silently breaks the contract.

## 9. Data

PostgreSQL via Prisma, in `packages/db`. Core Phase 1 entities: users, bookings, missions,
targets, captures, mission_events, observatory_state, plus observers (ADR-007) and the
loyalty ledger (ADR-008).

Frozen by ADR-003 and **not** part of Phase 1: the multi-observatory network,
subscriptions, the credit ledger, private sessions, `CaptureAccess`. The code remains; it is
not extended and not wired into the mission path.

The loyalty points ledger is **separate** from the frozen `CreditLedger` — building loyalty
on the frozen models would silently un-freeze subscriptions.

## 10. Audit and evidence

Every mission transition writes a `MissionEvent` with its source (`CLOUD`, `AGENT`,
`OPERATOR`). Every command writes an audit row. Nothing is fabricated or backdated.

This repository is how a reviewer verifies a deliverable before accepting it. The evidence
for a deliverable is the artefact the issue names — test output, simulator log, screenshot
— not the commit log alone.
