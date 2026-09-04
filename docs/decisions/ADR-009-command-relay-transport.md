# ADR-009 — How a minted command reaches the agent

- **Date:** 2026-09-04
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Arises from:** DV-058 — mission orchestrator, session ownership and command minting

## Context

`docs/architecture.md` §3 fixes the command flow:

```
client intent  ──▶  cloud: authorise, mint CommandEnvelope, pre-validate safety
               ──▶  realtime: relay to the agent that owns this mission
               ──▶  agent: validate AGAIN, independently
```

It does not say how the second arrow works, and that arrow crosses a process
boundary. `apps/api` mints the envelope; `apps/realtime` holds the only socket to
the observatory. They are separate Node processes by deliberate design — §2: "The
observatory socket is long-lived. A serverless function cannot hold it."

So the orchestrator cannot send the command itself. Something has to carry it.

`CLAUDE.md` narrows the field before it opens: no message queues and no extra
services without a measured need and maintainer approval. There is no measured
need for a broker to move a few commands per observing session.

## Decision

**PostgreSQL `LISTEN`/`NOTIFY`, with the `ObservatoryCommand` row as the source of
truth.**

The orchestrator writes the command row and issues `NOTIFY` in the same
transaction. The realtime service holds a dedicated `LISTEN` connection, wakes on
the notification, reads the row, and sends the envelope down the agent socket.

```
apps/api                             apps/realtime
  |                                    |
  | BEGIN                              | LISTEN darkview_command
  | INSERT "ObservatoryCommand"        |
  | NOTIFY darkview_command, <id>      |
  | COMMIT                             |
  |------------- postgres -------------|
                                       | SELECT the row
                                       | send CommandEnvelope over WSS
```

The notification carries **only an identifier and a kind**. The payload is read
from the database.

One channel, `darkview_agent`, carries both things the cloud sends the agent: a
minted command, and a `CloudSessionUpdate` saying who the session owner now is.
A session update has no command row, so its notification carries the mission and
session ids directly — still far inside the size limit, and still re-derivable
from `MissionSession` if it is missed.

## Why

- **No new service and no new listening port.** Both processes already hold a
  PostgreSQL connection. Nothing is added to the attack surface, and the
  observatory still accepts no inbound connection.
- **The command is durable before it is sent.** It is a database row first and a
  message second, which is what the audit requirement needs anyway: every command
  must be reconstructable after the fact.
- **A lost notification is not a lost command.** `NOTIFY` is fire-and-forget and
  is not delivered to a listener that is disconnected at that instant. Because the
  row is authoritative, the realtime service also sweeps for unrelayed commands on
  a slow interval and on reconnect. The notification is an optimisation on top of
  a poll, never the only path.
- **Ordering is per-transaction and sufficient.** Commands for one mission are
  minted serially behind the session-owner check, so the ordering `NOTIFY` gives
  is enough. Nothing here depends on cross-mission ordering.

## Alternatives considered

**An internal HTTP endpoint on the realtime service.** The orchestrator would POST
the envelope to `apps/realtime`. Rejected because it gives the realtime service an
inbound surface that must be authenticated, bound to a private interface and kept
off the internet — a standing security obligation, for a problem the database
already solves. It also leaves the command in flight rather than durable, so a
realtime restart mid-request loses it unless the row is written anyway; and if the
row is written anyway, the HTTP call is redundant.

**Polling `ObservatoryCommand` alone.** Correct and the simplest possible thing,
and it is retained here as the fallback path. Rejected as the primary because a
nudge is a live control: a customer moving the telescope should not wait out a
poll interval, and a short enough interval to feel immediate is constant database
traffic on an idle system.

## Consequences

- The realtime service needs one dedicated PostgreSQL connection for `LISTEN`,
  separate from its query pool, because a listening connection cannot be shared.
- `NOTIFY` payloads are capped at 8000 bytes. Sending only the id keeps this well
  clear of the limit permanently, whatever a payload grows into.
- The sweep interval is a fail-safe, not a schedule. If it ever becomes the path
  that delivers most commands, something is wrong with the notification path and
  the sweep is masking it. It logs when it finds work.
- This binds `apps/api` and `apps/realtime` to the same database. They already are.
- If Darkview ever runs more than one realtime instance, `LISTEN` broadcasts to
  every listener and each would relay the same command. The agent's idempotency by
  `commandId` makes that harmless rather than dangerous, but the duplicate work is
  a reason to revisit this before scaling out. `docs/network-future.md` is where
  that belongs.

## When this would be revisited

- More than one realtime instance per observatory.
- Measured latency that the notification path does not meet.
- A command payload that cannot sensibly be a database row first.

None of these apply in Phase 1.
