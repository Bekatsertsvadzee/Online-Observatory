# ADR-061 — A native client signs in with a bearer session

- **Date:** 2026-10-22
- **Status:** PROPOSED — built on the maintainer's choice of 2026-10-22 ("Mobile sign-in
  on platform"), from the clients' `docs/platform-requests/mobile-sign-in.md`, option 1.
- **Decided by:** project maintainer
- **Number:** 061: the two repositories share one sequence, and the clients' ADR-059
  started the mobile application.
- **Amends:** `ADR-016-http-authentication-boundary.md`, which deferred "how the native
  mobile app authenticates" until the mobile client was integrated, and whose §2 says no
  token is ever returned in a response body.

## Context

ADR-016 §3 refuses every mutation, and sign-in itself, unless `Origin` equals `APP_URL`,
and refuses a missing `Origin`. That check is what stops another site using the
customer's cookies: a browser attaches cookies to a request another page composed. A
React Native request has no `Origin` and no cookie jar shared with any page, so the
check refuses the mobile app outright, and so does the realtime service's handshake.

The request weighed three options: a bearer session, a fixed native `Origin` (forgeable
by any non-browser client, so it adds nothing and weakens §3), and platform attestation
(tied to store builds and Apple enrolment that do not exist yet).

## Decision

### 1. `POST /auth/native-sign-in` issues a bearer session

Same body as `POST /auth/sign-in`. On success it answers `200 NativeSession`:
`{ user, token, expiresAt }`. It sets no cookie. Same rate limits, same refusals
(`401 UNAUTHENTICATED`, `403 EMAIL_UNVERIFIED`, `429 RATE_LIMITED`), same audit events.

It is **not** Origin-checked. The check exists for sign-in because a cross-site form
could sign a visitor into the attacker's account by setting a cookie. This route sets
none, and its response body cannot be read by another site's page: the API sends no CORS
headers. Nothing a cross-site request could do here is worse than what any script can do
by calling the route directly, which the rate limits already bound.

### 2. The session row says which client it belongs to

`Session.client` is `WEB` (the default, every existing row) or `NATIVE`. A cookie is
accepted only for a `WEB` session and a bearer token only for a `NATIVE` one, so neither
credential can stand in for the other. A native session has the same seven-day lifetime
and is deleted by `POST /auth/sign-out`, like a cookie session. Its CSRF hash column holds
the hash of a random value nobody keeps.

### 3. A request with `Authorization` is judged by it alone

When a request carries an `Authorization` header, the API reads only that: a malformed
header or an unknown, lapsed or `WEB` token is unauthenticated, and the cookies are not
consulted as a fallback. Such a request skips the `Origin` check, because a browser never
attaches `Authorization` to a request on its own: a page that wants to send it must
already hold the token, and then CSRF is not the threat.

A request with no `Authorization` header is exactly ADR-016's: cookies, and the `Origin`
check on every mutation.

### 4. Realtime takes the same credential

The mission channel's handshake and the live view's stream accept
`Authorization: Bearer` for a `NATIVE` session, with no `Origin` check, on the same
reasoning: a browser cannot set a header on a WebSocket handshake or an `<img>` request.
Without the header, both are unchanged: Origin, then the `WEB` session cookie.

### 5. The contract

`components.securitySchemes.deviceSession` (`http`, `bearer`), and the document-wide
`security` becomes `userSession` **or** `deviceSession`. `NativeSession` is a new schema.
Nothing else changes for the web client.

## What this record deliberately does not decide

- Registration and email verification from the app. Both stay on the website for now:
  registration answers 202 and sends a link, and the link opens the website.
- Google sign-in for the app (ADR-048 redirects a browser and sets cookies).
- Where the app keeps the token. The clients' request proposes the platform keychain
  (`expo-secure-store`); that is the client's decision.
- Session listing, revoking other sessions, refresh tokens.

## When this would be revisited

If App Attest / Play Integrity become available with store builds, attestation can be
added on top of §1. If a third kind of client appears, `Session.client` gains a value
rather than a parallel table.
