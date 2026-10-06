# ADR-042 — Edit the profile, and change the email address

- **Date:** 2026-10-06
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Approved:** 2026-10-06, as written
- **Settles:** issue #172, the clients' platform request
  `docs/platform-requests/account-profile.md`
- **Amends:** `ADR-016-http-authentication-boundary.md`, which listed email change
  under "what this record deliberately does not decide"

## Context

`User` carries `displayName`, `email` and `locale`, and only `register` writes them. The
clients' profile page (roadmap C4) needs all three.

## Decision

Two endpoints, and a second kind of link behind an existing one. Each follows ADR-016:
the exact Origin check on every mutation, no token in a response body, and an
`AuthEventType` audit row for the address.

| Path                      | Body                         | Success    |
| ------------------------- | ---------------------------- | ---------- |
| `PATCH /me`               | `{ displayName?, locale? }`  | 200 `User` |
| `POST /me/email`          | `{ email, currentPassword }` | 202        |
| `POST /auth/verify-email` | `{ token }` (unchanged)      | 200 `User` |

1. **The name and the language are a plain edit.** `RegisterRequest`'s bounds; a name is
   trimmed and needs two characters. `locale` is the language the platform writes to the
   customer in, so the next email arrives in it. An empty body is 422. Metered per
   account with `PROFILE_POLICY`, twenty an hour, which protects nothing scarce and
   keeps a stuck client from filling the table's history.
2. **Asking for a new address needs the current password.** A wrong one is 422
   `VALIDATION_FAILED` with `details.fields: ["currentPassword"]`, as ADR-040 rule 5
   decided for `/me/password`, not the 401 the request proposed. Metered with
   `AUTHENTICATION_POLICY` on the account, because a wrong password is a guess at it.
   The address the account already has is 422 with `fields: ["email"]`.
3. **The answer never says whether the new address holds an account.** It is 202 either
   way. A free address is sent a link; an address that holds an account, verified or
   not, is told so, and is sent no link. The current address is told that a change was
   asked for, without the new address in the message.
4. **The account keeps its address until the link is followed.** The link is
   `APP_URL/{locale}/verify-email/{token}` in the account's language, so the web client
   needs no new page. The token is ADR-040's: 256 random bits, the SHA-256 hash stored,
   thirty minutes, consumed once by a conditional update. Its own table,
   `EmailChangeToken`, which also holds the new address, so a registration link can
   never move an address and a change link can never verify a registration. A new
   request replaces any earlier link.
5. **Following the link changes the address, ends every session, and signs in.** As
   `verifyEmail` does today, so whoever opens the link holds the only session. It also
   removes any outstanding password reset link, which went to the old address. If the
   address was taken between the request and the link, the link is dead: 422, as for an
   expired one.
6. **A password reset or change cancels a pending address change.** Whoever is taking
   the account back should not find it moving to an address somebody else chose.
7. **Three new message kinds go through the verification webhook,** signed the same
   way, or straight to Resend (ADR-035): `EMAIL_CHANGE` with `verificationUrl`,
   `EMAIL_CHANGE_REQUESTED` and `EMAIL_IN_USE` with no link. Both languages are the
   mail service's templates, and the platform's own copy when Resend is configured.

Three audit actions: `PROFILE_UPDATED`, `EMAIL_CHANGE_REQUESTED`, `EMAIL_CHANGED`.

## Where this departs from the request

- Wrong current password: 422 with the field named, not 401 (rule 2).
- The request's 200 on following the link said "every other session ends". Every
  session ends and the opener is signed in, because the link is often opened in another
  browser, and that is what `verifyEmail` already does (rule 5).
- A pending change is cancelled by a password reset or change (rule 6). The request did
  not cover it.

## Consequences

- Asking sends mail to two addresses, so delivery can fail after the token is written.
  A failure is 503 and the customer asks again; the new request replaces the token.
- The mail service needs three templates. The development mail sink in
  `darkview-clients` prints `verificationUrl` already, which is enough for `EMAIL_CHANGE`.
- The verification page in the web client serves both links, so its copy has to read
  right for a confirmed registration and a confirmed change alike.
