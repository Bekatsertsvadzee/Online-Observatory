# ADR-043 — A held booking carries its payment intent

- **Date:** 2026-10-07
- **Status:** APPROVED
- **Approved:** 2026-10-07, as written
- **Decided by:** project maintainer
- **Settles:** issue #176, the clients' platform request
  `docs/platform-requests/booking-payment-intent.md`
- **Amends:** nothing. `BookingWithPaymentIntent` and `createBooking` are unchanged.

## Context

`createBooking` answers `BookingWithPaymentIntent`, and that answer was the only place a
client ever saw the intent's `redirectUrl` and the hold's deadline. `Booking` carried
`paymentId` and nothing that could be followed. A customer who reserved a slot, left the
checkout and came back to the booking could cancel it or wait for the hold to lapse, and
could not pay. Roadmap slice C3 is that page's "Continue to payment".

The database already holds both halves: `Payment.redirectUrl`, written when the intent is
opened, and `Booking.holdExpiresAt`, which the check constraint requires on every
`PENDING_PAYMENT` row.

## Decision

1. **`Booking.paymentIntent`**, required and nullable. While the booking is
   `PENDING_PAYMENT` and a payment holds the slot, it is the same `PaymentIntent` that
   `createBooking` answered, with `expiresAt` the hold's deadline. In every other status
   it is null, whatever the payment row says: a settled, failed or lapsed payment has
   nothing to continue. It is also null for a booking a voucher or subscription minutes
   paid for, which has no payment.
2. **No new operation.** `GET /bookings/{bookingId}` and `GET /bookings` carry it. Every
   path that serialises a booking goes through `toContractBooking`, which answers an
   intent only from a row read with the payment; the two reads select it, and the
   reserve paths already have it. A path that returns a booking in any other status
   needs nothing.
3. **`createBooking` keeps its shape.** `BookingWithPaymentIntent` now repeats the
   booking's own field. Dropping it would change the one operation both clients'
   reserve step is built on, for no new information; it stays.
4. **A read does not expire a lapsed hold.** `expireLapsedHolds` runs where a slot is
   sold or judged, and the slot list already ignores a lapsed hold. A booking read
   after its deadline but before that sweep still reads `PENDING_PAYMENT`, with an
   intent whose `expiresAt` is past. The client treats a past `expiresAt` as lapsed and
   offers nothing to follow; the sandbox checkout refuses a lapsed hold either way.

## Where this departs from the request

Nowhere. The request's first shape is taken as written.

## Consequences

- Both clients' pinned contract gains a required field on `Booking`, so their fixtures
  and the fake platform must emit it on every booking before they sync.
- The booking page can show "Held until {time}" and follow `redirectUrl` the way the
  reserve step does: an `https:` address or one on the client's own origin, and
  nothing else.
