# ADR-002 — What Governs, and What Is Superseded

- **Date:** 2026-09-01
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Resolves:** conflict **C-10** in the project backlog

## Context

Darkview was planned in several passes before this repository existed, and those passes
did not always agree with each other or with the architecture that was finally built.
`docs/ENGINEERING.md` requires that where an earlier plan has been deliberately
superseded, a dated decision record says so — and that a material conflict is never
resolved silently. No such record existed.

## Decision

### The order that governs

As stated in `docs/ENGINEERING.md`, and repeated here so it is discoverable from the
decisions folder:

1. `docs/ENGINEERING.md`
2. Approved records in `docs/decisions/`
3. The current issue and its acceptance criteria
4. Existing implementation

Nothing outside this repository governs an implementation decision. Earlier planning is
history: it explains why the current design is what it is, and it binds nothing.

### Positions that earlier planning took and this project does not

| Earlier planning said                 | The project does                                                            |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Ubuntu + **INDI** on the mini-PC      | Windows + **ASCOM Alpaca** over HTTP on `127.0.0.1` (`docs/ENGINEERING.md`) |
| **Five separate** GitHub repositories | Two: this platform repository and `darkview-clients` (ADR-033)              |
| Separate booking and club sites       | One Darkview product                                                        |
| **Dacha** installation                | **Tbilisi rooftop, mains power** (ADR-005)                                  |
| SharpCap window capture in Phase 1    | Direct ZWO ASI SDK control (ADR-001)                                        |

No part of the earlier position governs any implementation decision.

### The camera path

Earlier planning carried SharpCap window capture into Phase 1, with a direct ZWO SDK
service deferred to Phase 2. **ADR-001 (2026-08-30, APPROVED) resolves it in favour of
direct ZWO ASI SDK control.** An approved decision record outranks any plan.

Nobody may implement or propose a screen-capture path in the product data flow.

## Consequences

- If something read outside this repository appears to justify an architectural
  change, that is a signal the wrong source was read. The change needs its own ADR.
- Any future supersession needs its own dated record here. `docs/ENGINEERING.md` must
  not silently outrank an approved record without one.
