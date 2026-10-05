# ADR-040 — Reset a forgotten password, and change a known one

- **Date:** 2026-10-05
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Approved:** 2026-10-05, as written
- **Settles:** issue #171, the clients' platform request
  `docs/platform-requests/account-password.md`
- **Amends:** `ADR-016-http-authentication-boundary.md`, which listed password reset
  under "what this record deliberately does not decide"

## Context

The contract had `register`, `verifyEmail`, `signIn`, `signOut` and `getCurrentUser`.
A customer who forgot their password had no way back to their bookings and Collection,
and a signed-in one could not change it. Roadmap slice C1 puts this before launch.

## Decision

Three endpoints. Each follows ADR-016: the exact Origin check on every `POST`, no token
in a response body, and an `AuthEventType` audit row.

| Path                                | Body                            | Success                              |
| ----------------------------------- | ------------------------------- | ------------------------------------ |
| `POST /auth/password-reset`         | `{ email, locale }`             | 202, always                          |
| `POST /auth/password-reset/confirm` | `{ token, password }`           | 200 `User`, sets the session cookies |
| `POST /me/password`                 | `{ currentPassword, password }` | 204                                  |

1. **Asking never says whether the address holds an account.** It answers 202 to an
   unknown and a known address alike, as `register` does. An account, verified or not,
   is sent `APP_URL/{locale}/reset-password/{token}`; an unknown address is sent nothing.
   A new link replaces any earlier one. Metered with `AUTHENTICATION_POLICY` on the
   address and the email together, as registration is.
2. **The token is a verification token in all but name.** 256 random bits, the SHA-256
   hash stored, thirty minutes, consumed once by a conditional update so two requests
   carrying one link cannot both succeed. Its own table, `PasswordResetToken`, so a
   verification link can never set a password.
3. **A used, expired or unknown token is 404 `NOT_FOUND`.** The client can tell it from
   a 422 for a malformed body, and offer a fresh link. Not metered, for the reason
   `/auth/verify-email` is not: there is nothing to guess.
4. **Confirming ends every session the user held**, then signs them in. Whoever held the
   old password is signed out everywhere. On an unverified account it also verifies the
   address, which the link has just proved, removes any verification link, and grants
   the welcome bonus as `verifyEmail` would. This is the defence against an address
   registered by somebody who does not own it: a verification link would sign the
   owner in with the stranger's password still set.
5. **Changing a known password keeps this session and ends every other.** A wrong current
   password is 422 `VALIDATION_FAILED` with `details.fields: ["currentPassword"]`, not
   401: a 401 reads to a client as a lost session. It costs the same scrypt work as a
   right one. Metered with `AUTHENTICATION_POLICY` on the account, because a wrong
   current password is a guess at it. Any outstanding reset link is removed.
6. **The email goes through the verification webhook**, signed the same way, with
   `kind: "PASSWORD_RESET"` and `resetUrl` in the body. A verification message carries
   no `kind`. Both languages are the mail service's templates, as for every email.
7. **Passwords keep `RegisterRequest`'s bounds,** 12 to 128 characters.

Three audit actions: `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET`, `PASSWORD_CHANGED`.

## Where this departs from the request

- The request proposed sending an unverified account its verification link instead of a
  reset. Review found that leaves a stranger's password on the account (rule 4).

- The request proposed 401 for a wrong current password. This record uses 422 with the
  field named (rule 5).
- The request proposed `429` under `AUTHENTICATION_POLICY` on every `POST`. Confirming is
  not metered (rule 3): keyed on an unattributed address, it would be one bucket for
  every customer.

## Consequences

- Asking for a reset sends mail only for an address that holds an account, so the time
  the 202 takes says more than its status does, and a failed delivery is a 503 only for
  a known address. `register` has both properties today. Sending after the response
  would close them, and is not done here.
- The hosted demo (ADR-035, PR #166) sends verification through Resend. When it merges,
  the reset email needs the same path, and the demo's shared accounts need
  `POST /me/password` refused, or one visitor can lock out the next.
- The development mail sink in `darkview-clients` prints a `verificationUrl`. It must
  print `resetUrl` for a `PASSWORD_RESET` message.
