# ADR-046 — A reconnect is not a restart

- **Date:** 2026-10-07
- **Status:** APPROVED
- **Approved:** 2026-10-08, as written
- **Decided by:** project maintainer
- **Settles:** the expected failure `keeps an OBSERVING mission live when the agent
  reconnects holding it` (`apps/realtime/src/link/mission-state.test.ts`), raised again as
  P1 by the clients' test audit of 2026-10-07
- **Amends:** `ADR-010-agent-local-state-store.md`, which gave `AgentHello.resumeMissionId`
  its meaning
- **Amended by:** `ADR-047-a-restart-that-forgot-its-mission-still-ends-it.md`, for a
  restart whose hello names no mission

## Context

`AgentHello.resumeMissionId` is described as "set when the agent restarts holding a
mission recovered from its local state store". The cloud reads it that way:
`resolveResumedMission` fails the mission `AGENT_LINK_LOST`, records a CLOUD event and
revokes the session, because an agent that restarted has parked and lost the state
machine's progress.

The agent sends the field on every hello while a mission is active, a reconnect after a
two-second blip included, and `agent/tests/test_supervisor.py` asserts it. That is right:
an agent that said nothing would look idle, and the cloud would schedule against a
telescope in use.

The agent's watchdog already separates a blip from a loss. Past `heartbeatLossSeconds` it
stops capture and the mount keeps tracking; past `linkDeadSeconds` it parks, the runner
cancels the mission, and the reason reaches the cloud as a mission event once the link is
back. So a short blip leaves the mission alive on the telescope, and the cloud alone ends
it. A customer loses a paid observation to a network stall the hardware rode out.

## Decision

The hello already carries `bootedAt`, the agent process's start time. It is the process
identity the cloud needs.

1. **The cloud remembers the `bootedAt` it last accepted**, as
   `Observatory.agentBootedAt`, written in the same step as the hello is recorded.
2. **A hello with `resumeMissionId` and the remembered `bootedAt` is a reconnect.** The
   mission is left in its state, the session stands, and the welcome names it as live.
   The agent's own mission events say what happened during the gap: a Park past
   `linkDeadSeconds` arrives as the runner's failure, as it does today.
3. **A hello with `resumeMissionId` and a different or unremembered `bootedAt` is a
   restart.** `resolveResumedMission` runs exactly as now: FAILED, `AGENT_LINK_LOST`,
   session revoked. The fail-safe path is unchanged.
4. **The contract's description of `resumeMissionId` becomes "the mission the agent is
   holding"**, and `bootedAt`'s says the cloud compares it to tell a reconnect from a
   restart. No field is added or removed; the shape is unchanged.

## Alternatives not taken

- **Read `resumeMissionId` as "currently held" and always resume.** Simpler, but it would
  resume after a real restart, when the agent has parked and lost its progress; the
  mission would sit live with nothing driving it.
- **A new `restarted: boolean` on the hello.** Equivalent, but it is a second statement of
  what `bootedAt` already says, and an agent bug could make the two disagree.
- **Stop the agent sending the field on a reconnect.** The cloud would then see an idle
  observatory holding a mission, which is the failure the agent's behaviour prevents.

## Verification

Real PostgreSQL and the simulator, for: a short blip with the same process (mission stays
OBSERVING, session stands); a new process (FAILED, `AGENT_LINK_LOST`, session revoked); an
owner whose session expired during the gap (revoked, as `_expire_owner` and the cloud
already do); a mission that ended during the gap (`NOT_LIVE`, unchanged); and a link dead
past `linkDeadSeconds` (the agent's own failure event ends it). The `it.fails` test becomes
an ordinary test.

## Consequences

- One migration: a nullable `Observatory.agentBootedAt`. The first hello after deploy has
  nothing remembered, so it is read as a restart: the conservative end.
- The agent changes nothing.
- A clock change on the observatory mini-PC does not alter `bootedAt` for a running
  process, since it is taken once at start-up.
