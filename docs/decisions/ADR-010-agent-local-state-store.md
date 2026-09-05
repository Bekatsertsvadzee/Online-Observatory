# ADR-010 — The Observatory Agent's local state store

- **Status:** Accepted
- **Date:** 2026-09-04
- **Issue:** DV-027
- **Supersedes:** nothing

## Context

Everything the Observatory Agent knew about itself lived in memory: which
commands it had already decided, what it had audited, who owned the telescope,
and the measured safety limits it enforces. A restart lost all of it.

That is not a bookkeeping gap. `docs/observatory-protocol.md` states it plainly:

> The in-memory simulator ledger is development-only. A production observatory
> agent must persist idempotency records and command receipts across restarts
> before hardware integration is enabled.

The failure it describes is concrete. A restart is exactly when the cloud stops
receiving acknowledgements and begins retrying, so a retried command arriving at
an agent with no memory of having run it is the ordinary case, not the strange
one. A slew performed twice is the highest-consequence duplicate in the system.

Three other things were losing state for related reasons:

- `command/audit.py` carried the note "DV-027 gives this durability across a
  restart". The agent's audit is the account written by the machine that actually
  holds the telescope, and it was being lost in exactly the crash that makes
  somebody want to read it.
- `AgentHello.resumeMissionId` is documented in the contract as "set when the
  agent restarts holding a mission recovered from its **local state store**". No
  local state store existed, so the field could never be anything but null.
- `CloudSafetyEnvelopeUpdate` says the agent "stores it locally and keeps
  enforcing it after the cloud link dies". It did not store it, so an agent that
  rebooted during a network outage came back UNMEASURED and refused every slew —
  safe, but the wrong kind of safe, because the limits had been measured.

## Decision

**One SQLite file, `darkview_agent/state/store.py`, opened for the life of the
process.** Its path is `DARKVIEW_AGENT_STATE_PATH`, defaulting to
`~/.darkview/agent-state.sqlite3`.

It holds four things:

| | Why it must survive |
| --- | --- |
| Decided command ids | A retry across a restart is refused, not performed again |
| The audit log | The local account of an incident outlives the incident |
| Session ownership, with the spent nudge allowance | A restart neither drops the customer nor refills their drift budget |
| The measured safety envelope | A reboot during an outage keeps limits that were measured |

Three properties are deliberate:

**The audit log is append-only, enforced by a trigger.** `BEFORE UPDATE` raises.
The log's entire value is that nobody can revise it afterwards, so the rule lives
somewhere that does not depend on every future caller being careful. Deletion is
permitted, but only as age-based retention — removing an old record is retention,
changing one is falsification.

**Writes are synchronous** (`PRAGMA synchronous=FULL`). The volume is a few rows
per mission and the entire purpose is surviving the power cut, so trading
durability for throughput here would trade away the only thing the file is for.

**A recovered mission is reported, never resumed.** The agent comes back knowing
a mission id and nothing else — not which frame, not which centring iteration,
not whether the slew had settled. Continuing from that would be guessing about
where a telescope is pointing. So the mount is parked, `resumeMissionId` tells the
cloud the observatory came back holding a mission nobody is flying, and the cloud
closes it out. Ownership, by contrast, *is* restored: it is a fact the agent can
still prove, and dropping it would refuse every command until the customer
noticed and reopened their session.

## Alternatives considered

**JSON files in a directory.** Simplest to read by hand, and wrong for the one
event that matters. A crash mid-write leaves a half-written file, which is exactly
the artefact this store exists to not produce. Making it safe means atomic
rename plus a separate append-only log format plus a lock — which is a worse
SQLite.

**PostgreSQL, shared with the cloud.** Defeats the architecture. The observatory
accepts no inbound connection and must keep enforcing safety with the link dead;
a state store that needs the network is no state store at all.

**Nothing — keep it in memory and accept the loss.** Explicitly ruled out by
`docs/observatory-protocol.md` as a precondition for hardware integration.

**A key-value library (LMDB, `shelve`, `diskcache`).** Adds a dependency to get
less: no schema, no append-only enforcement, no query for retention.

## Consequences

- SQLite is in the Python standard library, so no dependency is added. It is a
  file, not a process, so the rule in `CLAUDE.md` about not introducing extra
  services is untouched.
- The store is used from two threads — the watchdog records what it is about to
  do before it acts — so the connection is opened with `check_same_thread=False`
  behind an internal lock.
- `AuditLog` gained a sink and does **not** raise when that sink fails. The
  watchdog audits before it parks, so an exception on a full disk would stop a
  Park to protect a log entry. Failures are counted and logged instead.
- Retention is bounded: decided commands for 7 days, audit events for 90. Pruning
  runs once, on recovery. An agent running for many months between restarts
  accumulates rows, all of them tiny.
- The file is a real artefact on the observatory mini-PC. Backup and restore
  (DV-114) has to include it, and it must never be copied between observatories:
  it names sessions, users and missions belonging to one installation.

## When this would be revisited

If a state write is ever measured on the critical path of a command — it is not
today; a command produces a handful of small rows — the first thing to relax is
`synchronous=FULL` on the ownership row, never on the audit or the idempotency
set. Those two are the reasons this file exists.
