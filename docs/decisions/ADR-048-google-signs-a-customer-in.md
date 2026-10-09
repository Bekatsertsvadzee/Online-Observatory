# ADR-048 — Google signs a customer in

- **Date:** 2026-10-09
- **Status:** PROPOSED — built on the maintainer's instruction of 2026-10-09 ("I need
  Google auth also, simple login"); approval of the record itself is still his
- **Decided by:** project maintainer
- **Amends:** `ADR-016-http-authentication-boundary.md`, whose direction was "no external
  identity provider". The session, the cookies and the password sign-in are unchanged;
  this adds a second way to arrive at the same session.
- **Relates to:** `ADR-035-a-hosted-demo-deployment.md` (the demo has no email sender, so
  password registration is refused there until Resend is configured)

## Context

Registration needs a verification email, and the hosted demo sends none, so the first
visitor to try saw "Authentication is temporarily unavailable." The maintainer wants a
sign-in that does not depend on email delivery, and wants it to be Google.

ADR-016 chose cookie endpoints on this API and no external identity provider. That
decision was about where the session lives and how a client presents it. It still holds:
the session is still this API's cookie, verified on the server, and the mission channel
still reads the same cookie. What changes is that a customer can prove an address to
this API by signing in with Google instead of by clicking a link we emailed.

## Decision

1. **The authorisation-code flow, on this API.** `GET /auth/google/start` sends the browser
   to Google with a random `state`, remembered in a short-lived signed cookie together with
   the locale. `GET /auth/google/callback` checks the state against the cookie, exchanges
   the code for Google's ID token on the API over TLS, and reads `sub`, `email`,
   `email_verified` and `name` from it. The client secret never leaves this API, and no
   Google script runs in the browser; the client's "Continue with Google" is a link.
2. **A verified Google address is a verified address.** The account holding that email is
   signed in and linked by `User.googleSubject`; an account that never verified its email
   is verified by this. No account holds it: one is created, verified, with Google's name,
   and a loyalty account as registration gives. Thereafter the `googleSubject` is the key,
   so a later change of the Google address does not detach the account.
3. **Nothing else changes.** The session is `createSession`'s cookie, the audit trail gets
   `REGISTERED` (when created) and `LOGIN_SUCCEEDED`, and rate limiting meters the start
   per address under `AUTHENTICATION_POLICY`, where the address is trustworthy
   (`TRUSTED_PROXY_HOPS`), as registration's per-address cap is. A deleted account (ADR-044) is never revived
   through Google: its link is cleared with the rest of the identity.
4. **One failure outcome.** Every failure -- no configuration, a stale or forged state,
   Google refusing the code, an unverified address -- lands on
   `APP_URL/{locale}/sign-in?error=google`. None of them is the visitor's to fix.
5. **Configuration.** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, both or neither. The
   redirect URI registered with Google is `APP_URL/api/auth/google/callback`: through the
   website's `/api` path, because the `__Host-` session cookie must be set on the host the
   browser is on.

## Alternatives not taken

- **Google Identity Services in the browser** (the rendered Google button, an ID token
  posted to the API). It needs Google's script and iframe in the CSP, renders Google's
  button in Google's style on a poster-language page, and leaves the token to be verified
  against Google's JWKS. The redirect flow needs none of that.
- **A general OAuth layer or an auth library.** One provider was asked for; the flow is
  two routes and one function. A second provider is a second record.
- **Skipping email verification in demo mode.** It would unblock registration on the demo
  by weakening ADR-016 where it matters most, and would not survive the real launch.

## Consequences

- One migration: `User.googleSubject`, nullable, unique.
- A customer who arrived through Google has no `Account` row and so no password. The
  profile's password change asks for the current one and will refuse; setting a password
  goes through the reset link, which needs email. Acceptable for now; a "set a password"
  path is a later record if anyone asks.
- The demo still needs Resend for password registration. Google makes the demo usable
  without it.
