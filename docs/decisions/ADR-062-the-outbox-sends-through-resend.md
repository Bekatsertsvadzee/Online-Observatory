# ADR-062 — The outbox sends through Resend, and a card's winner is emailed

- **Date:** 2026-10-22
- **Status:** PROPOSED — built on the maintainer's instruction of 2026-10-22 to start the
  notification emails, with an email for a weekly card's winner.
- **Decided by:** project maintainer
- **Relates to:** DV-064 (the email outbox), ADR-035 §5 (the verification email through
  Resend), ADR-060 (the weekly card draw), ADR-025 (the product is Stellar to a customer).

## Context

DV-064 writes every customer email to an outbox, `EmailNotification`, in the transaction
of the event that causes it, and the realtime service delivers it to a mail service's
signed webhook. The webhook's mail service was to own the wording. It was never built, so
on the hosted demo every booking confirmation, reminder, refund, capture and gift voucher
email has waited in the outbox since 2026-10-08, and the booking page can only ever say a
confirmation is queued. The API already sends its own emails (verification, password
reset, email change) straight to Resend's HTTP API when `RESEND_API_KEY` and `EMAIL_FROM`
are set, with the wording in this repository (ADR-035 §5, ADR-040).

ADR-060 issues prizes, and a winner has no reminder of one but the cards page.

## Decision

1. **The realtime service sends the outbox straight to Resend** when `RESEND_API_KEY` and
   `EMAIL_FROM` are set on it, both or neither, the same pair the API holds. It wins over
   the webhook when both are configured; with neither, emails wait in the outbox as before.
   Everything DV-064 promises is kept: a row is claimed before it is attempted, what it
   says is read at the moment of sending, a failure is retried with backoff and given up
   on after eight attempts, and the row's id is the `Idempotency-Key`, so Resend sends one
   email for a retried row.
2. **The wording lives here**, in `apps/realtime/src/notifications/templates.ts`, in
   English and Georgian, one template per `EmailNotificationKind`, chosen by the account's
   locale. Each email says what happened in one or two sentences and links to the page on
   the website (`APP_URL`) where its current state is. An email never says more than that
   page: a simulated capture says it is simulated, a refund names the amount refunded and
   no more. A kind with no template fails its delivery rather than sending something empty.
3. **A weekly card's winner is emailed.** A pick that wins a prize queues
   `CARD_PRIZE_WON` (dedupe key `card-prize-won:{prizeId}`, payload the prize id) in the
   pick's transaction. The email names the prize, the observatory and the last day it can
   be used, and links to the cards page. It carries no code: the winner reads it on the
   cards page, signed in. It is not sent for a prize spent or expired by the time of
   sending. A COMMON card queues nothing.
4. **No contract change.** The outbox is internal; `Booking.confirmationEmail` already
   reports what became of a confirmation.

## Consequences

- With the pair set on Fly, the queued backlog is delivered on the first passes. Rows for a
  booking no longer CONFIRMED, a voucher spent or a prize used are skipped, as DV-064 does.
- Sending needs a Resend account and `EMAIL_FROM` on a domain Resend has verified; until
  then nothing changes.
- The webhook path stays for a deployment that runs its own mail service.
