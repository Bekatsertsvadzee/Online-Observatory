# ADR-017 — The operator reads live telemetry from the process that holds the agent socket

- **Date:** 2026-09-14
- **Status:** APPROVED
- **Decided by:** project maintainer, in session (direction: the realtime service
  serves it over HTTP, not a stored row)
- **Approved:** 2026-09-14, as written
- **Arises from:** DV-063, which did not build `GET /admin/observatory/state` because
  this decision did not exist; issue #73
- **Relates to:** `ADR-011` (live view transport), `ADR-009` (command relay),
  `docs/network-future.md` § One realtime process, for now

## Context

`OperatorObservatoryState.telemetry` is a required `ObservatoryTelemetry`: mode, link,
mount, camera and focuser health, weather, pointing and `reportedAt`. The agent already
sends exactly that shape, several times a second, inside every `AGENT_STATE_DELTA`.

Nothing keeps it. `apps/realtime` relays a delta to the customers watching a mission and
drops it; a delta sent while no mission is held is dropped unread. `apps/api`, which owns
the contract path, is a different process and has never seen one.

DV-063 named two answers: a single throttled latest-telemetry row, or the realtime
service exposing what it holds on its own HTTP surface, the way ADR-011 did for frames.
The maintainer chose the second.

## Decision

### 1. The realtime service holds the latest sample per observatory, in memory

Every `AGENT_STATE_DELTA` from an authenticated link replaces that observatory's sample,
whether or not it names a mission. One sample per observatory, never queued, never
written to the database or to disk. It is released when the link closes or expires, so a
sample can never outlive the connection that produced it.

`lastHeartbeatAt` is the link's last activity, which the watchdog already tracks.

### 2. It is served on an internal path, to the API only

`GET /internal/observatories/{observatoryId}/state` on the realtime service's existing
HTTP server returns the sample and `lastHeartbeatAt`.

It is authenticated by `Authorization: Bearer <REALTIME_INTERNAL_SECRET>`, compared in
constant time. It carries no cookie and trusts no Origin: its caller is a server. Every
refusal and every absence — no header, wrong secret, unknown observatory, no link, no
sample yet — is the same `404`, the rule ADR-011 set for the stream.

The secret is the control. The reverse proxy must additionally not route `/internal/*`
from the internet; that is defence in depth, not a substitute, and the RUNBOOK says so.

### 3. The API assembles the contract response

`GET /admin/observatory/state` stays an API route behind `requireOperator`. It resolves
the first-party observatory (issue #76), calls the internal path at
`REALTIME_INTERNAL_URL` with a two-second timeout, and adds what the database knows:

| Field | Source |
| --- | --- |
| `telemetry`, `lastHeartbeatAt` | realtime, §2 |
| `safetyEnvelope` | `loadSafetyEnvelope` |
| `activeMissionId`, `activeSessionId` | the live mission and its unrevoked session |
| `linkLatencyMs` | `null` — nothing measures a round trip, and a guess is not a latency |
| `updatedAt` | the telemetry's `reportedAt` |

### 4. No sample is a 503, not an invented one

When the realtime service has no sample, cannot be reached, or `REALTIME_INTERNAL_URL` is
unset, the route answers `503 OBSERVATORY_OFFLINE`. When the observatory has no safety
envelope row, `503 SAFETY_NOT_CONFIGURED`. Both codes already exist.

A response that filled `telemetry` with `DISCONNECTED` devices would describe equipment
the cloud cannot see. The envelope and the missions stay readable through
`/admin/observatory/safety-envelope` and `/admin/missions`, which do not depend on the
link.

**This is a contract change:** the path gains a `503` response. No schema changes.

### 5. New configuration

- `REALTIME_INTERNAL_SECRET` on both services. No default, minimum 32 characters, and
  separate from `AUTH_SECRET` and `STREAM_SIGNING_SECRET` so each can be rotated alone.
- `REALTIME_INTERNAL_URL` on the API. No default.

## Alternatives considered

**A throttled latest-telemetry row.** Declined by the maintainer. It would survive a
realtime restart and need no internal secret, at the cost of a continuous write stream
for data that is stale within a second.

**The operator's browser calls the realtime service directly**, authenticated by the
session cookie as the stream is. Rejected: the contract puts the path under the API, and
the operator role check would then live in two processes.

## Consequences

- The realtime service gains a second HTTP route and its first caller that is not a
  browser.
- Telemetry exists only while the agent is connected to the one realtime process. A
  restart empties it until the next delta, a fraction of a second after reconnection.
  A second realtime instance breaks this exactly as it breaks frames and `LISTEN`; that
  is already recorded in `docs/network-future.md`.
- A deployment that puts the API somewhere it cannot reach the realtime service gets
  `503` from this route and nothing else breaks.

## What this deliberately does not decide

- A telemetry history, charts, or alerting on it.
- A measured `linkLatencyMs`.
- Pushing telemetry to the operator console over a WebSocket.
- Which observatory the path names (issue #76).

## Amendment proposed 2026-09-14 — the internal payload belongs in the contract

**Status of this amendment: APPROVED 2026-09-14.** Found before implementation, not after.

§2's response crosses a process boundary: `apps/realtime` serialises it and `apps/api`
reads it. `CLAUDE.md` makes `contracts/openapi.yaml` the only source of truth for every
payload that does that, with no hand-written duplicate in either service. As approved,
this record would have had each service define the shape for itself.

The amendment adds one schema and changes nothing else in the decision:

```yaml
ObservatoryTelemetrySnapshot:
  type: object
  additionalProperties: false
  required: [observatoryId, telemetry, lastHeartbeatAt]
  properties:
    observatoryId: { type: string, format: uuid }
    telemetry: { $ref: "#/components/schemas/ObservatoryTelemetry" }
    lastHeartbeatAt: { type: string, format: date-time }
```

It is declared under an `x-darkview-internal` block beside `x-darkview-websockets`, with
the path `/internal/observatories/{observatoryId}/state` and its bearer scheme, so it is
generated into TypeScript and Zod for both services and is visibly not client surface.
`darkview-clients` receives the schema in its pinned copy and has no path that uses it.

## When this would be revisited

- More than one realtime instance.
- A hosting choice in which the API cannot reach the realtime service privately.
- An operator need for telemetry while the agent is disconnected, which only a stored
  row can meet.
