# ADR-047 — A restart that forgot its mission still ends it

- **Date:** 2026-10-09
- **Status:** APPROVED
- **Approved:** 2026-10-09, as written
- **Decided by:** project maintainer
- **Settles:** finding F2 of the hosted demo's walkthrough of 2026-10-08: the Fly machine
  sleeps when idle and has no volume, so an agent that wakes mid-mission hellos with
  `resumeMissionId: null` and the mission it was driving never closes
- **Amends:** `ADR-046-a-reconnect-is-not-a-restart.md`, which settles only a hello that
  names a mission

## Context

ADR-046 reads a hello with `resumeMissionId` and a remembered `bootedAt` as a reconnect,
and one with a different `bootedAt` as a restart that is closed out: FAILED,
`AGENT_LINK_LOST`, session revoked. Both cases rest on the agent naming the mission,
which it recovers from its local state store (ADR-010).

The hosted demo's machine stops when nobody holds a connection through Fly's proxy and
starts on the next request. It has no volume, so `/data` is new on every start: the
agent that wakes has neither the process nor the state store that held the mission. Its
hello names nothing. The cloud, told nothing, resolved nothing, and the mission sat in
`OBSERVING` with `Mission_active_per_observatory_unique` holding the observatory shut
against every later session. The same would follow a mini-PC reimaged mid-night, or a
state store deleted by hand.

A second gap sat beside it. `markLinkUp` remembered the new `bootedAt` in one
transaction and `resolveResumedMission` closed the mission in another. A crash between
the two left the process remembered and the mission open, and the next hello from that
process read as a reconnect — so the mission would never close.

## Decision

1. **A restarted process that names no mission closes the observatory's live mission**,
   if there is one, exactly as ADR-046 closes a named one: FAILED, `AGENT_LINK_LOST`, a
   CLOUD event and the session revoked. The event says the agent came back without the
   mission it was holding. The welcome then names no mission, which is what the agent
   holds.
2. **The same process that names no mission closes nothing.** A blip between a mission
   being minted and its GOTO reaching the agent is still a reconnect; the pending command
   is relayed when the link is back, as ADR-009 already has it.
3. **Nothing remembered closes nothing.** `Observatory.agentBootedAt` is null only before
   the first hello after ADR-046's migration, and the cloud cannot then say which process
   drove the mission. The agent's own events end it, as before.
4. **Remembering the process and settling the mission are one transaction.**
   `markLinkUp` takes the hello's `bootedAt` and `resumeMissionId` together and returns
   what it did; `resolveResumedMission` is no longer a separate step. The mission is
   settled before `agentBootedAt` is written, so a rolled-back hello leaves the next one
   reading the process as the restart it is.

## Alternatives not taken

- **A volume under the demo machine.** It would keep the state store across a sleep, and
  the agent would then name the mission. It leaves the reimaged mini-PC and the deleted
  store unhandled, and it is a hosting choice, not a rule; the rule has to hold without
  it.
- **Close on every hello that names nothing while a mission is live.** It would close a
  mission on the blip in decision 2, which the agent's watchdog rode out.
- **Keep the machine always on.** Decided against on cost on 2026-10-08; it also changes
  nothing about the two other causes.

## Verification

The fake store and real PostgreSQL, for: a new process naming nothing (FAILED,
`AGENT_LINK_LOST`, session revoked, CLOUD event, welcome names nothing, a second mission
can start); the same process naming nothing (mission and session untouched); nothing
remembered and nothing named (untouched). ADR-046's cases unchanged.

## Consequences

- The agent changes nothing. The contract changes nothing.
- The demo's seeded live mission is a separate fault: a seed never ends it. The seed now
  writes that mission COMPLETE.
