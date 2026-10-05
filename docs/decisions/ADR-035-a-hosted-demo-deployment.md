# ADR-035 — A hosted demo deployment

- **Date:** 2026-10-01
- **Status:** APPROVED
- **Decided by:** project maintainer (Nika)
- **Request:** `darkview-clients` `docs/platform-requests/hosted-demo.md`, against `f2f51db`
- **Context document:** `darkview-clients` `docs/plan/hosting.md`
- **Amends:** the six `NODE_ENV === "production"` money guards (DV-050, DV-056, ADR-007,
  ADR-022 §11, DV-112) and the rule that registration needs
  `EMAIL_VERIFICATION_WEBHOOK_URL` / `_SECRET`
- **Relates to:** `ADR-022` (monthly subscriptions), `ADR-032` (simulator envelope)
- **Temporary:** turned off for the real launch (Consequences)

## Context

The website is live with no platform behind it, so nothing signed-in works. The
maintainer decided on 2026-10-01 to host the platform first as a **demo**: booking end to
end on the sandbox checkout, a simulated observatory only, no real money, no hardware.

Two behaviours stood in the way. A hosted Next.js build always runs with
`NODE_ENV=production`, and six places refuse the sandbox payment provider there, so a
hosted demo could not book. And registration was refused unless
`EMAIL_VERIFICATION_WEBHOOK_URL` was set, while nothing receives that webhook yet.

`NODE_ENV` cannot be the switch: it also decides the `__Host-` session cookie and its
`Secure` flag, which a public deployment must keep.

## Decision

1. **`DARKVIEW_DEPLOYMENT`**, `production` (default) or `demo`, in the environment schema
   of both the API and the realtime service. Any other value fails validation; unset is
   `production`.
2. **The six money guards ask one predicate per service**, `sandboxMoneyAllowed`:
   `NODE_ENV !== "production" || DARKVIEW_DEPLOYMENT === "demo"`. They are
   `reserveSlot`, `resolvePaymentProvider` (the SANDBOX case), `subscribe`,
   `purchaseGiftVoucher`, `purchaseObserverPack`, and the realtime service's sandbox
   renewal charger. In a demo the sandbox works as it does in development, and a demo's
   payments are never real.
3. **A demo never commands hardware.** `setObservatoryMode` refuses a switch to REAL with
   403 `FORBIDDEN` on a demo, before any other check and whatever the attendance
   statement says. Both services refuse to start on a demo while any observatory row is in
   REAL mode: the realtime service before it accepts a socket, the API in its
   `instrumentation.ts` `register`, which Next runs once per server instance before the
   first request. Only a demo queries the database there.
4. **Nothing else changes.** Cookies stay `__Host-` and `Secure` under
   `NODE_ENV=production`; every other production check holds.
5. **The verification email may go through Resend.** With `RESEND_API_KEY` and
   `EMAIL_FROM` set (both or neither), `sendEmailVerification` posts to
   `https://api.resend.com/emails` itself, in the customer's locale (`en` or `ka`), under
   the customer-facing name Stellar (`darkview-clients` ADR-025). Otherwise it uses the
   signed webhook as before. Either path is enough for registration. No SDK: one `fetch`,
   a 5-second timeout and a thrown error on any non-OK answer, like the webhook.
6. **The notification emails stay queued.** The nine notification kinds are untouched:
   with `NOTIFICATION_WEBHOOK_URL` unset they wait in the outbox, as the runbook
   documents. Their delivery and wording are a later decision.

## Consequences

- A demo's bookings, subscriptions, vouchers and observer packs are sandbox payments in a
  database that may look like production. The demo database is never promoted to the
  real launch's; the real launch starts from its own.
- The contract's "SANDBOX is never selectable in a production environment" now reads,
  for this platform, "in a production deployment": a demo is a production build, not a
  production deployment. No contract text, operation or schema changes.
- An operator on a demo cannot put an observatory into REAL mode, and a demo cannot be
  pointed at a database where one is. Real hardware needs a deployment that is not a demo.
- **For the real launch, `DARKVIEW_DEPLOYMENT` is unset (or `production`) on both
  services.** With it, the six guards refuse the sandbox again until a real provider's
  adapter exists. Once no deployment uses `demo`, the flag and this exception are removed
  in their own change.
- The Resend sender stays an option after the demo; it is the webhook's alternative, not
  part of the demo exception.
