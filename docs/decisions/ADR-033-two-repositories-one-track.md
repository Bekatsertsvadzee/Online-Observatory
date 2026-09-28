# ADR-033 — Two repositories, one track

- **Date:** 2026-09-28
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Mirrors:** `darkview-clients` ADR-031, the same decision from the clients' side
- **Amends:** `CLAUDE.md`, "Repository boundary" (no UI here) and "Definition of done"

## Context

Work paused here on 2026-09-22 and moved to `darkview-clients`, which treated this
repository as read-only and wrote every gap up as a platform request. Eight requests stood
open, one contract operation was never served, and the two halves had never run together.
The hardware has not arrived. The maintainer wants both halves finished on the simulator
first, so that when the hardware arrives only the device connection remains.

## Decision

1. **One track.** The clients' requests are issues here (#144–#152) and are built here, in
   order, each on its own branch and pull request. A contract change is made here and
   copied to the clients with their `npm run contracts:sync` after it merges.
2. **The simulator is the finish line.** Both halves are done when register, book, pay
   (sandbox), observe, capture and collection run on the clients' `npm run dev:stack` with
   simulated agents. Real-hardware mode stays behind an attended operator action.
3. **UI here only where it is necessary.** A page may be served from `apps/api` when it
   stands in for an outside party the platform plays itself, such as the sandbox checkout
   (#149), which stands in for a payment provider's hosted page. It stays minimal, works
   without script, and never becomes a product surface: customer and operator screens
   belong to the clients.
4. **Identities.** Commits here carry the maintainer's identity configured in this
   checkout, Beka Tsertsvadze. Pull requests may be opened and closed from another account
   with push access; the squash commit on `main` is made locally under the maintainer's
   identity and pushed, so the account that opened a pull request never becomes an author.

## Consequences

- ADR-014's merge conditions are unchanged: approval in that session, green CI on the
  head, a squash, no agent in the authorship.
- Decision records in both repositories share one number sequence from here, so the two
  directories merge without collisions.
