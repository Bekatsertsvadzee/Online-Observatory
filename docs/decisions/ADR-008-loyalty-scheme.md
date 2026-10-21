# ADR-008 — Darkview Loyalty: written new, for Darkview

- **Date:** 2026-09-01
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Relates to:** `ADR-003` (the frozen surface)

## Context

Phase 1 includes a loyalty scheme on the website and in the mobile application. No
engineering plan existed for either, and the question was whether to build it on the
models this repository already has, or on something brought in from outside.

## Decision

**Darkview's loyalty scheme is written new, for Darkview,** on the stack this repository
already runs. Nothing is imported from any other product.

### What it is

- **The scheme** — tier names, thresholds, earn and redemption rates — is published
  business terms, held as configuration.
- **The mechanics** are general engineering practice: an append-only ledger, idempotency
  by source reference, earning caps, tier derived from purchase-earned points only, a
  denormalised balance with a recalculation path, and admin adjustment with an audit
  trail.

### What it is not

- **No second stack.** `docs/ENGINEERING.md` pins Phase 1 to PostgreSQL + Prisma and
  forbids new services without measured need and maintainer approval. Loyalty uses the
  existing Prisma schema and the existing realtime service.
- **No retail concepts.** Darkview sells Observation Slots. There is no shop, no product
  catalogue and no in-store receipt upload in this scope.

## Why this is the right route

- **One stack.** A second database and auth system for a marketing balance is not a
  measured need, and it would have to be operated, backed up and secured alongside the
  primary one.
- **The domain model is Darkview's.** Observation Slots, Missions and Captures, not
  purchases. Anything shaped for retail would have to be rewritten to fit.

## Consequences

- Loyalty gets **its own ledger**, not the `CreditLedger` frozen by ADR-003. The frozen
  ledger models paid session credits; loyalty points are an earned marketing balance with
  different rules, no monetary liability and no refund path. Building loyalty on the
  frozen models would silently un-freeze subscriptions.
- Loyalty needs **its own contract surface** in `contracts/openapi.yaml` before any code
  is written (DV-091). No local types.
- **Tier configuration is data, not code.** Thresholds, rates and tier count are
  configuration, so the open question of two tiers versus four does not block
  implementation and can be answered late.
- Scheduling: behind Milestone S1 and behind the payment path (DV-056), because loyalty
  earns on settled payments. Nothing here is on the critical path to the first real
  mission.
- Reversing this — a single club spanning more than one product — is a new ADR, not an
  implementation choice.
