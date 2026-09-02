# ADR-004 — The Authoritative Mission State Machine

- **Date:** 2026-08-30
- **Status:** APPROVED
- **Supersedes:** Darkview Build Plan §08 state list; the `MissionState` enum in
  `prisma/schema.prisma` as it stood at commit `5a61c9b`
- **Decided by:** project maintainer
- **Resolves:** conflict C-1 in the project backlog

## Context

Three documents in this project defined three different mission state
enumerations, and no decision record said which one governed.

- `CLAUDE.md` — ten primary states and five failure/hold states.
- Darkview Build Plan §08 — additionally defines `LOCKED` and `DELIVERED` as
  primary states and `SOLVE_FAILED`, `LINK_LOST`, `EXPIRED` as failure states,
  and omits `FAILED`.
- `prisma/schema.prisma` — the `CLAUDE.md` list with `PLATE_SOLVING` written
  where `CLAUDE.md` has `VERIFYING`.

The mission state machine crosses every process boundary in the system: the
orchestrator drives it, the agent reports it, the database persists it and the
live room renders it. Three spellings of it is three bugs waiting.

## Decision

The mission state machine is **exactly the enumeration in `CLAUDE.md`**, and
nothing else.

Primary, in order:

```
REQUESTED -> SCHEDULED -> PREPARING -> SLEWING -> VERIFYING -> CENTERING
          -> OBSERVING -> CAPTURING -> PROCESSING -> COMPLETE
```

Failure / hold: `WEATHER_HOLD`, `NOT_VISIBLE`, `HARDWARE_ERROR`, `CANCELLED`,
`FAILED`.

`VERIFYING` is the ASTAP plate-solve step. `CENTERING` applies the solved offset
and re-slews, bounded to three iterations. Any state may enter a failure or hold
state, and every path out of a failure or hold state ends at Park.

`LOCKED` and `DELIVERED` are **not** states and get no representation in the
contract, the database or the API.

## Consequences

- `contracts/openapi.yaml` `MissionState` already implements this list. It does
  not change.
- `prisma/schema.prisma` renames `PLATE_SOLVING` to `VERIFYING`. That is a
  migration, and it is the only mission-state schema change permitted.
- The Build Plan's extra failure conditions survive as **diagnostic detail, not
  as states**: `MissionFailureReason` in the contract carries `SOLVE_FAILED`,
  `LINK_LOST`, `EXPIRED` and the rest alongside a state above. They are never
  mapped into `MissionState` and never rendered as a stage in a progress
  indicator.
- The Build Plan's customer-facing progression copy ("Target locked" -> "LIVE")
  is **presentation**, not state. The live room may display "Target locked" as
  the label for `VERIFYING`/`CENTERING` and "LIVE" for `OBSERVING`. That mapping
  lives in the web layer, is a display concern only, and must never leak back
  into the enum.
- No agent may add a state to this enum. A genuinely new state is a contract
  change and needs a new ADR.

## Why not add `LOCKED` and `DELIVERED`

They describe moments the system already has: `LOCKED` is the successful exit
from `CENTERING`, and `DELIVERED` is `COMPLETE` plus a capture the customer can
see. Adding them would buy nothing the label mapping above does not, and it would
mean amending a controlling document to match a subordinate one.
