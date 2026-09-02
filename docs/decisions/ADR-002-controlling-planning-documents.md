# ADR-002 — Which Planning Documents Govern, and Which Are Superseded

- **Date:** 2026-09-01
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Resolves:** conflict **C-10** in the project backlog

## Context

the private planning archive holds several planning documents written at different times, some of
which contradict each other and the current architecture. `CLAUDE.md` requires that where
an earlier plan has been deliberately superseded, a dated decision record says so — and
that a material conflict is never resolved silently. No such record existed.

Filenames are actively misleading here: the file called *"Darkview updated plan.md"* is
the **older** document, and `CLAUDE.md` is younger than every plan in the folder.

## Decision

### The order that governs

As stated in `CLAUDE.md`, and repeated here so it is discoverable from the decisions
folder:

1. `CLAUDE.md`
2. Approved records in `docs/decisions/`
3. Darkview Brand Identity System **v2.0** — identified by ADR-006 as
   the Brand Identity System source PDF (private brand archive, outside this repository)
4. Darkview Phase 1 Final Master Plan
5. Darkview Build Plan — engineering detail only, where it does not contradict 1–4
6. The current issue and its acceptance criteria
7. Existing implementation

### Document status

| Document | Dated | Status |
| --- | --- | --- |
| `DARKVIEW_Phase1_Master_Plan_v2.md` | 2026-08-28 | **Current master plan**, except §9 — see below |
| `Darkview_Build_Plan.pdf` | 2026-08-28 | **Current**, engineering detail only, subordinate to 1–4 |
| `Darkview updated plan.md` | 2026-08-28 | **Superseded** by Master Plan v2 in every section v2 covers |
| `Astroman-Step-by-Step.md` | 2026-08-18 | **Fully superseded.** Not a controlling document. |

### `Astroman-Step-by-Step.md` is superseded in full

It specifies an architecture this project does not build:

| It says | The project does |
| --- | --- |
| Ubuntu + **INDI** on the mini-PC | Windows + **ASCOM Alpaca** over HTTP on `127.0.0.1` (`CLAUDE.md`) |
| **Five separate** GitHub repositories | One monorepo (ADR-006 of the Build Plan layout; C-6, resolved 2026-08-31) |
| Separate `book.astroman.ge` and `club.astroman.ge` sites | One Darkview product |
| **Dacha** installation | **Tbilisi rooftop, mains power** (ADR-005) |

No part of it governs any implementation decision. It is retained as history.

### `Darkview updated plan.md` — the filename trap

Despite the name, this is the **v1 Final Master Execution Plan** of 2026-08-28. Master
Plan v2 supersedes it in every section v2 covers. Where v2 is silent, v1 may still inform
context, but it never outranks v2.

**This trap is written down deliberately.** An agent reading the folder by filename would
reasonably take "updated plan" for the newest document. It is not.

### Master Plan v2 §9 is stale on the camera path

v2 §9 states that the decision to use SharpCap window capture in Phase 1, with a direct
ZWO SDK service deferred to Phase 2, carries over from v1 unchanged. The Build Plan
reverses it, and **ADR-001 (2026-08-30, APPROVED) resolves it in favour of direct ZWO ASI
SDK control.**

An approved decision record outranks both plans. Master Plan v2 §9 is superseded **on
this point only**; the rest of v2 stands.

No agent may implement or propose a screen-capture path in the product data flow.

## Consequences

- Reading `Astroman-Step-by-Step.md` is not grounds for any architectural choice. If its
  contents appear to justify a change, that is a signal the wrong document was read.
- Where Master Plan v2 and the Build Plan conflict, v2 wins — except where an ADR has
  decided otherwise, as ADR-001 does on the camera path.
- Superseded documents are **retained, not deleted.** The planning history is part of
  the record and explains why the current design is what it is.
- Any future supersession needs its own dated record here. `CLAUDE.md` must not silently
  outrank a controlling document without one.
