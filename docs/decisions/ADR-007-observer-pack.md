# ADR-007 — The Observer Pack

- **Date:** 2026-08-31
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Partially supersedes:** `ADR-003-phase-1-scope-boundary.md` — the shared-observation
  portion of the frozen surface only. Everything else ADR-003 froze stays frozen.

## Context

`CLAUDE.md` states: *one active mission at a time, one active session owner at a time.*
That rule is about **control** — who decides where the telescope points. It has never
said only one person may *watch*.

ADR-003 froze the shared-observation surface this morning because no controlling
document contained it. The maintainer has now decided it is a Phase 1 product feature, so
that portion of the freeze is lifted deliberately and on the record.

The commercial case: a customer wants to observe tonight, but the slot is taken. Rather
than turn them away, they can pay a smaller fee to watch the session that is already
live.

## Decision

Darkview Phase 1 sells an **Observer Pack**: a paid, view-only seat on a live session
that somebody else controls.

### The rules

1. **Exactly one controller.** The session owner alone chooses the target and issues
   commands. This is unchanged and non-negotiable — it is a `CLAUDE.md` rule.
2. **Observers never command.** An observer cannot slew, capture, abort or park. This
   is enforced structurally, not by UI: `CommandEnvelope` carries `sessionId` and
   `userId`, the cloud mints envelopes only for the session owner, and **the agent
   independently rejects any command whose `sessionId` is not the current owner**. An
   observer therefore has no path to the mount even if every layer above is
   compromised.
3. **Maximum five observers** per session, in addition to the controller. A hard cap,
   enforced server-side.
4. **View only.** Observers watch the live view and mission state. They receive **no
   captures** — nothing enters their Collection. Keeping an image requires booking a
   session.
5. **The controller opts in, per session.** Sessions are **private by default**. A
   session becomes observable only when its owner chooses to open it. Nobody is
   watched without agreeing.
6. **Price:** an Observer Pack seat is priced below a full session; the exact figure is
   commercial and set outside this record.

## Why these limits

- **Five, not unlimited.** A cap of five fans out to a handful of WebSocket clients
  from the existing realtime service. Unlimited observers would mean a media server or
  CDN — new infrastructure that `CLAUDE.md` forbids adding without measured need and
  maintainer approval. Five keeps the product intimate and the architecture unchanged.
- **View-only.** It keeps a clear reason to book your own session, and it keeps the
  media pipeline simple: captures belong to the person who commanded them.
- **Opt-in.** This is a premium personal product. "Your time with a real telescope"
  does not survive being watched by default.

## Consequences

- **ADR-003 is amended.** The shared-observation surface — `MissionParticipant`,
  `MissionPresence`, `MissionSharingMode`, `MissionJoinPolicy`,
  `MissionParticipantStatus` — is **unfrozen** and becomes Phase 1 scope.
  `CaptureAccess` **stays frozen**, because observers get no captures.
- **Still frozen by ADR-003:** the multi-observatory network, subscriptions and the
  credit ledger, and private sessions. This ADR does not touch them. A fleet is still a
  different product.
- **The contract must model observers** before any code is written: an observable flag
  on a mission, an observer capacity and count, a join operation, and an observer-scoped
  view of the mission channel that carries telemetry and stream but no command
  capability. No agent may add a local type for this.
- **Sequencing:** built after Milestone S1, in week 3. The two-week simulator sprint is
  unchanged. The contract and this record land first so that DV-057, DV-058 and DV-060
  are designed with observers in mind and nothing is rebuilt.
- **Safety is unaffected.** Observer count has no bearing on the safety envelope,
  `MAX_ALT_SAFE`, session ownership or command validation. If any observer feature ever
  requires relaxing command authorisation, it is wrong and stops.
