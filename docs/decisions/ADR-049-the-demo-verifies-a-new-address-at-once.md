# ADR-049 — The demo verifies a new address at once

- **Date:** 2026-10-09
- **Status:** PROPOSED — built on the maintainer's instruction of 2026-10-09 ("there has to
  be another way, find it and make it"); approval of the record itself is still his
- **Decided by:** project maintainer
- **Amends:** `ADR-016-http-authentication-boundary.md` ("no session is issued until the
  address is verified"), on the demo deployment only
- **Relates to:** `ADR-035-a-hosted-demo-deployment.md` (what `DARKVIEW_DEPLOYMENT=demo`
  may and may not do), `ADR-048-google-signs-a-customer-in.md`

## Context

The hosted demo has no email sender, so `POST /auth/register` answers 503 and the first
visitor to try saw "Authentication is temporarily unavailable." Resend would fix it and
is still the plan for the real launch, which needs email for more than verification. The
maintainer wants registration to work on the demo now, without it.

ADR-016 withholds the session until the address is verified so that nobody can hold an
account under an address that is not theirs. On the demo that account can reach a
simulated telescope, sandbox money and demo captures, and nothing else.

## Decision

1. **On `DARKVIEW_DEPLOYMENT=demo`, with neither Resend nor the webhook configured, a new
   address is verified at once and signed in.** `register` answers `{ ok, user }` and the
   route 200 with the session cookies, exactly as sign-in does. The audit trail gets
   `REGISTERED` and `LOGIN_SUCCEEDED`.
2. **An address that already holds an account is still 202 and no session.** Re-registering
   somebody else's address, verified or not, signs nobody into it. The password they set
   on that attempt is not stored.
3. **Configured email wins.** The moment Resend or the webhook is set, the demo sends the
   link and withholds the session like any other deployment. Nothing has to be undone.
4. **Production is unchanged.** Without email delivery it still refuses registration with
   503: a real launch that cannot send email has a misconfiguration, not a case.

## Alternatives not taken

- **Resend now.** Right for launch; the maintainer asked for a way without it.
- **Gmail SMTP from the maintainer's account.** Keeps verification, but needs an app
  password from him and a second sending path to maintain for a demo.
- **A link printed to the operator's Telegram** through the existing webhook. The link
  would reach the maintainer, not the visitor who registered.

## Consequences

- The demo's accounts are self-asserted addresses. They were already demo accounts.
- The sign-in form's registration path lands in the app on 200 and on "check your email"
  on 202, so the client reads the status.
