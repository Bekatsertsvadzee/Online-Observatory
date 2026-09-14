# ADR-016 — A client signs in over HTTP, and the credential is the cookie DV-051 already issues

- **Date:** 2026-09-14
- **Status:** APPROVED
- **Decided by:** project maintainer, in session (direction: cookie endpoints in this
  spec, no external identity provider)
- **Approved:** 2026-09-14, as written
- **Relates to:** `DV-051` (sessions and roles), `DV-060` (mission channel cookie),
  issue #73, `docs/audits/2026-09-13-review.md` (P1, client authentication)

## Context

DV-051 built sessions, roles, password hashing, email verification and the audit
trail. What it exposed was a set of Next.js server actions, `features/auth/actions.ts`,
carried over from the UI that has since moved to `darkview-clients`. A separate
repository cannot call a server action over HTTP, and the production build's
server-action manifest is empty. So no client can sign in, and every authenticated
endpoint in the contract is unreachable from the real clients.

The contract also disagrees with the code about what the credential is.
`components/securitySchemes/userSession` says `http bearer`. The API has never read an
`Authorization` header: `getCurrentSession` reads two cookies, and the realtime
service's mission channel reads the same session cookie.

## Decision

### 1. Four endpoints, in this contract, backed by the DV-051 session

| Path | Body | Success |
| --- | --- | --- |
| `POST /auth/register` | `displayName, email, password, locale` | `202`, no body |
| `POST /auth/verify-email` | `token` | `200 User`, sets the session |
| `POST /auth/sign-in` | `email, password` | `200 User`, sets the session |
| `POST /auth/sign-out` | none | `204`, clears the session |

No external identity provider and no new service. The session row, its lifetime,
roles and the verified-email requirement are unchanged; this record exposes them, it
does not redesign them.

**Registration answers `202` whether or not the address is new.** An endpoint that
said "already registered" would be an oracle for which email addresses hold an
account. An unverified address is sent a fresh verification link; a verified one is
sent nothing.

**The verification link points at the web client**, `APP_URL/{locale}/verify-email/{token}`,
as it does today. That page posts the token to `/auth/verify-email`. The page is
`darkview-clients` work.

### 2. The credential is a cookie, and the contract says so

`userSession` becomes `type: apiKey, in: cookie`. Two cookies are issued together:

- `__Host-darkview_session` — `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. The
  credential.
- `__Host-darkview_csrf` — readable by the page, same attributes otherwise. A session
  is only valid when both are present and match the stored hashes.

Outside production the `__Host-` prefix is dropped, because a browser refuses a
`__Host-` cookie over plain HTTP. OpenAPI names one cookie; the description names both.

No token is ever returned in a response body. A token in a body is a token a client
has to store somewhere, and every place a web page can store one is readable by
script.

### 3. CSRF: SameSite=Lax plus an exact Origin check on every mutation

Every `POST` under `/auth` goes through the same exact-origin check as every other
mutating route (`requireApiMutation`, against `APP_URL`), and so does sign-in.
Sign-in is included deliberately: a cross-site form that signs the victim into the
attacker's account is a known attack even though no session is stolen.

A missing `Origin` header is refused, not waved through.

### 4. One host

`__Host-` cookies are sent only to the host that set them. The API (`/api`), the
realtime service (`/ws`) and the web client are served from **one host, on paths**.
DV-060 already imposed this on realtime; it now applies to the API too.

### 5. Rate limits and audit are the ones DV-051 wrote

`AUTHENTICATION_POLICY` keyed on address and email for sign-in and registration,
`REGISTRATION_ORIGIN_POLICY` on the address for registration, and the existing
`AuthEventType` audit rows. A refusal is `429 RATE_LIMITED`.

## What this record deliberately does not decide

- **How the native mobile app authenticates.** A React Native request normally
  carries no `Origin` header, so §3 refuses its mutations. Accepting a missing
  `Origin` would reopen the CSRF check for old or unusual browsers. The options — a
  mobile-specific bearer token, a native `Origin`, or a platform attestation — are a
  separate decision, taken when the mobile client is integrated.
- Password reset, email change, account deletion.
- Multi-factor authentication.
- Session listing or revoking other sessions.

## When this would be revisited

If the web client has to be served from a different host than the API, the
`__Host-` prefix and §4 do not survive, and the credential design is reopened rather
than patched with `SameSite=None`.
