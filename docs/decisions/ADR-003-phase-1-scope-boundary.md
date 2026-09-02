# ADR-003 — Phase 1 Scope Boundary: the Frozen Surface

- **Date:** 2026-08-30
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Amended:** 2026-08-31 by `ADR-007-observer-pack.md`, which unfreezes the
  shared-observation surface (`MissionParticipant`, `MissionPresence`,
  `MissionSharingMode`, `MissionJoinPolicy`, `MissionParticipantStatus`) as Phase 1
  scope. `CaptureAccess` stays frozen. Everything else below stands.
- **Resolves:** conflict C-7 in the project backlog

## Context

The repository as it stands models product surface that appears in no controlling
document. `CLAUDE.md` describes one product: one customer, one reservation, one
operator-approved target, one real telescope. The Build Plan data model is
`users, bookings, missions, targets, payments, captures, mission_events,
observatory_state`. Master Plan v2's Phase 1 scope matches.

Against that, `prisma/schema.prisma` and `src/` additionally implement:

| Area                     | Artefacts                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Multi-observatory network | `ObservatoryNetworkNode`, `NetworkAvailabilityWindow`, `NetworkNodeKind`, `NetworkNodeApprovalStatus`, `src/features/network/`, `src/components/network/`, `docs/network-future.md` |
| Shared observations       | `MissionParticipant`, `MissionPresence`, `MissionSharingMode`, `MissionJoinPolicy`, `MissionParticipantStatus`, `CaptureAccess`, `CaptureAccessStatus`, `src/features/shared-observations/`, `src/components/missions/shared-mission.tsx` |
| Subscriptions and credits | `Subscription`, `SubscriptionPlan`, `SubscriptionStatus`, `CreditLedger`, `CreditLedgerReason`                        |
| Private sessions          | `PrivateSession`, `PrivateSessionStatus`                                                                              |

A multi-observatory partner network is not a variation on Phase 1. It is a
different product from "one person and one real telescope", and it carries
different safety, ownership and settlement questions.

## Decision

This surface is **frozen and out of Phase 1 scope**.

Frozen means, precisely:

1. **The code stays.** Nothing in the table above is deleted. A large unexplained
   deletion is worse than an honest, documented boundary.
2. **It is removed from Phase 1 acceptance.** No frozen artefact appears in the
   acceptance matrix (DV-012) or in any Phase 1 deliverable claim.
3. **It is not extended.** No agent adds a field, a model, a route, a component
   or a test to the frozen surface. No Phase 1 issue may depend on it.
4. **It is not wired into the Phase 1 mission path.** The mission runner, the
   orchestrator, the agent link and the live room behave as though exactly one
   observatory and exactly one session owner exist, because per `CLAUDE.md` that
   is the product: one active mission at a time, one active session owner at a
   time.
5. **The contract does not model it.** `contracts/openapi.yaml` describes Phase 1
   only. Absence of a frozen concept from the contract is deliberate and is not a
   contract gap to be filed.

Encountering a frozen artefact is not authorisation to use it. If a Phase 1 task
appears to need one, that is a scope question for the maintainer, not an
implementation choice.

## Consequences

- `docs/network-future.md` is retained as forward-looking design material and is
  explicitly labelled as out of Phase 1 scope.
- Frozen Prisma models remain in the schema and in migrations. They are unused in
  Phase 1 and may hold no production rows.
- `src/features/network/`, `src/features/shared-observations/` and their
  components and tests remain, and their tests keep running so the tree stays
  green. They gain no new behaviour.
- Unfreezing any part of this is an maintainer decision recorded in a new ADR, with
  its own decomposition and its own funding. It is not a refactor.
