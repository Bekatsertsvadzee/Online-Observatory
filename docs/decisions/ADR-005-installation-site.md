# ADR-005 — Phase 1 Installation Site

- **Date:** 2026-08-31
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Resolves:** conflict C-11 in the project backlog

## Context

Planning documents disagreed on where the telescope physically goes. Earlier
planning placed it on a **dacha terrace running off-grid solar**; the v1 Final
Master Execution Plan §1 placed it on a **Tbilisi rooftop on mains power**. Master
Plan v2 §2 Decision 3 recorded the discrepancy as unresolved.

The site is not a detail. Build Plan step P1 requires a compass survey of every
obstruction bearing at the actual site, and that survey becomes `HORIZON_MASK`. No
site means no horizon mask, which means no safe remote operation and no GATE 1.

## Decision

Phase 1 is installed on a **Tbilisi rooftop, on mains power**.

This matches `CLAUDE.md`, which describes Darkview as "a Live Remote Observatory in
Tbilisi, Georgia".

## Consequences

- **Off-grid power is out of Phase 1.** No battery sizing, no solar budget, no
  charge-controller telemetry. Mains power with a UPS for graceful shutdown is the
  assumption. If that assumption is wrong, this ADR is wrong.
- The compass survey (maintainer action O-4, Build Plan P1) is performed at the rooftop
  and produces `HORIZON_MASK` for that location's obstruction bearings. A survey
  from any other location is not valid for this site.
- `MAX_ALT_SAFE` remains **unmeasured** and is unaffected by this decision. It is a
  property of the assembled optical train, not of the site, and is measured in
  DV-034 (maintainer action O-5). It stays `null` — meaning UNMEASURED — until then, and
  both cloud and agent refuse every slew with `SAFETY_ENVELOPE_UNMEASURED` while it
  is null.
- Network path for the outbound WSS is a rooftop-adjacent mains-powered connection.
  Link quality is validated during DV-034 rather than assumed.
- **Still required from the maintainer:** written permission from the property owner for
  the rooftop installation. This ADR records the choice of site, not the right to
  occupy it.
