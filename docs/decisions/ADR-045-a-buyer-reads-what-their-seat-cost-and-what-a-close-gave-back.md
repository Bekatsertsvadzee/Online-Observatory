# ADR-045 — A buyer reads what their seat cost and what a close gave back

- **Date:** 2026-10-07
- **Status:** APPROVED
- **Approved:** 2026-10-07, as written
- **Decided by:** project maintainer. That the observer is shown the amount refunded was
  decided on 2026-10-02 (ADR-036's follow-up); this record is the read that shows it.
- **Settles:** issue #169, the clients' platform request
  `docs/platform-requests/observer-refund-read.md`
- **Amends:** `ADR-034-the-watch-view-and-no-presence.md`, which decided who may read the
  watch view; `ADR-036-ten-observers-and-a-refund-for-the-time-a-close-takes.md`, whose
  owed refund was kept out of the contract

## Context

ADR-036 refunds a paid observer for the time a close takes, and records it on
`ObserverPack.refundedMinor`, or on `refundOwedMinor` when the provider cannot refund yet.
Nothing returned either after the close:

- `purchaseObserverPack` was the only operation that returned an `ObserverPack`, and it
  refuses a closed session.
- `getMissionWatchView` answered 404 to the observer after a close: their seat is `LEFT`
  and the session is no longer open, which removed both grounds it read on.
- `refundOwedMinor` was deliberately not a contract field, so that an owed refund could
  never be shown as paid.

## Decision

The request's first shape, unchanged.

1. **A PAID pack is a ground to read the watch view, in any mission state.** Beside the
   owner, an attached seat, and a live session its owner opened. It grants nothing:
   ADR-007 stands, and the view still carries no capture and no way to save one. A pack
   still awaiting payment is not a ground; a hold buys nothing yet.
2. **`MissionWatchView.myObserverPack`**, required and nullable: the caller's own pack on
   the mission in whatever status, or null. The owner, who cannot buy one, gets null.
3. **`ObserverPack.refundOwedMinor`**, integer or null, beside `refundedMinor`. The
   database already keeps the two apart (`ObserverPack_refund_issued_or_owed`), so a pack
   carries one or the other, never both. The contract says a client presents it as owed,
   "will be refunded", never as refunded; that keeps ADR-036's promise that an owed
   refund is never shown as paid, by naming it rather than hiding it.

## Where this departs from the request

Nowhere. The request offered a dedicated `GET /missions/{id}/observer-pack` as an
alternative; the watch view is the page that needs the values, so it carries them.

## Consequences

- Both clients' pinned contract gains a required field on `MissionWatchView`, so the fake
  platform must emit `myObserverPack` on every watch view before it syncs.
- A buyer keeps reading a session they paid for after it ends. That is the mission's
  state, target and observatory, which they saw while watching; nothing new is disclosed.
- ADR-044 still wins: a deleted owner's watch view is a 404 to everybody, a paying
  observer included.
