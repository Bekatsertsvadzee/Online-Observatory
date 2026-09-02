# ADR-008 — Darkview Loyalty: reimplement, do not reuse

- **Date:** 2026-09-01
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Relates to:** `ADR-003` (the frozen surface)

## Context

Phase 1 includes a loyalty scheme on the website and in the mobile application. No
engineering plan existed for either.

A complete loyalty platform already exists in a separate, unrelated product: Next.js on
Supabase, with a WooCommerce plugin, member surfaces and an admin API. It is available
to this project as a reference.

Adopting it would import a second database stack and a retail domain model into a
product that sells Observation Slots, and would make this codebase's origin statement
untrue.

## Decision

**Darkview's loyalty scheme is written new, for Darkview.** The existing platform is a
**reference for architecture and business rules — never a source of code.**

### What may be taken

- **The scheme itself** — tier names, thresholds, earn and redemption rates. These are
  published business terms, visible on the live site.
- **Architectural patterns** — an append-only ledger, idempotency by source reference,
  earning caps, deriving tier from purchase-earned points only, a denormalised balance
  with a recalculation path, admin adjustment with an audit trail. These are general
  engineering practice, taken as design in prose, never as code.

### What may not be taken

- **No file, function or fragment is copied** from the reference platform into this
  repository. Not adapted, not translated, not renamed.
- **Supabase does not enter Darkview.** `CLAUDE.md` pins Phase 1 to PostgreSQL + Prisma
  and forbids new services without measured need and maintainer approval. The Darkview
  implementation uses the existing Prisma schema and the existing realtime service.
- **No WooCommerce or retail concepts.** Darkview sells Observation Slots. There is no
  shop, no product catalogue and no in-store receipt upload in this scope.

## Why this is the right route

- **One stack.** A second database and auth system for a marketing balance is not a
  measured need, and it would have to be operated, backed up and secured alongside the
  primary one.
- **The origin statement stays true.** The private provenance record asserts this
  codebase reuses no application code from any older product. Under this decision that
  statement remains accurate and needs no correction.
- **The domain model differs anyway.** The reference platform models retail purchases.
  Darkview models Observation Slots, Missions and Captures. Most of what would be
  "reused" would have to be rewritten to fit.

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
- Reversing this — a single club spanning both products — is a new ADR, not an
  implementation choice.
