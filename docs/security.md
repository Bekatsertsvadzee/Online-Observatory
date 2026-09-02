# Darkview security model

## Scope

This document covers account authentication, session management, authorization, and the boundary between the web application and observatory control software. Darkview does not connect to physical telescope hardware in this implementation. `ObservatoryAdapter` remains an interface, and the command policy produces an authorization decision only.

## Trust boundaries

1. The browser is untrusted. It may request a high-level mission action, but it cannot hold telescope credentials, create leases, declare the observatory ready, or approve its own safety checks.
2. Next.js Server Actions and server-only services form the application boundary. Every state-changing action validates the request origin and its inputs.
3. PostgreSQL is the source of truth for users, roles, email verification, sessions, rate limits, and authentication audit events.
4. The observatory adapter is a separate server-side boundary. A future adapter may receive an already-authorized command from a trusted server process only.
5. Email verification delivery is a server-to-server webhook. Requests are signed with `EMAIL_VERIFICATION_WEBHOOK_SECRET`; the verification bearer token is never returned by the registration UI.

## Authentication

Passwords are normalized only at the email boundary; passwords themselves are never trimmed or transformed. The accepted password length is 12–128 characters. Passwords are hashed with Node.js `scrypt` using a random 32-byte salt, cost `N=65536`, block size `r=8`, parallelization `p=1`, and a 64-byte derived key. Verification uses a constant-time comparison. Failed sign-in attempts use the same derivation path even when the email does not exist, reducing account-enumeration timing differences.

Email addresses are stored lowercase and unique. New accounts receive a cryptographically random, 30-minute, single-use email verification token. Only the SHA-256 token hash is stored. Authentication is refused until `emailVerifiedAt` is set. Verification consumes the token, revokes older sessions, and creates a fresh session.

The email webhook must be configured before registration is enabled:

- `EMAIL_VERIFICATION_WEBHOOK_URL`
- `EMAIL_VERIFICATION_WEBHOOK_SECRET` (at least 32 characters)

The receiving mail service must verify the `x-darkview-signature` HMAC over the exact request body before sending mail.

## Sessions and cookies

Sessions are database-backed. The browser receives a random opaque token; the database stores only its SHA-256 hash. A session is valid only when the token exists, is unexpired, belongs to an email-verified user, and has a valid CSRF token bound to that session.

Production cookies use the `__Host-` prefix and are configured with:

- `Secure`
- `HttpOnly` for the session token
- `SameSite=Lax`
- `Path=/`
- seven-day expiration
- high cookie priority

The CSRF cookie is intentionally readable so forms can submit it, but its hash is bound to the server-side session. Possession of a forged CSRF cookie without the matching database value is insufficient. Logout is POST-only, checks same-origin and the CSRF token, deletes the database session, and expires both cookies.

## CSRF and request integrity

Every authentication mutation compares the `Origin` header with the configured `APP_URL`. Missing, malformed, or cross-origin values fail closed. Authenticated mutations additionally require the session-bound CSRF token. Next.js Proxy is an optimistic navigation gate only; it is never treated as the final authorization check.

Production must set `APP_URL` to the exact public HTTPS origin. If a reverse proxy is used, it must replace rather than append untrusted forwarding headers.

## Rate limiting

Registration and sign-in use PostgreSQL-backed buckets keyed by an HMAC of the request actor and normalized email. Raw IP addresses and email addresses are not stored in rate-limit keys or audit actor fields. The default policy permits five attempts per 15-minute window and blocks further attempts for 15 minutes.

At the deployment edge, add a second IP/device-level limit before Next.js. The application limit protects the identity flow; it is not a substitute for upstream denial-of-service controls. Periodically delete expired sessions, consumed/expired verification tokens, old rate-limit buckets, and audit events according to the retention policy.

## Roles and authorization

Roles are stored in PostgreSQL and loaded during every secure session verification:

| Role       | Consumer missions               | Administrative observatory commands | Account administration |
| ---------- | ------------------------------- | ----------------------------------- | ---------------------- |
| `USER`     | Own active mission only         | Never                               | Never                  |
| `OPERATOR` | Operationally assigned missions | Yes, after all command checks       | No                     |
| `ADMIN`    | As authorized                   | Yes, after all command checks       | Yes                    |

UI visibility is not authorization. `assertRole` and `requireRole` are server-only checks. Administrative command entry points must require `OPERATOR` or `ADMIN` at the handler and service layers. A `USER` request for an administrative command is rejected before mission or lease evaluation.

## Telescope command invariant

`authorizeTelescopeCommand` fails closed and authorizes only when all conditions are true:

1. The actor has a server-verified authenticated session.
2. The command category is permitted for the actor’s database role.
3. The mission exists, its session is active, and its state is operational.
4. A `USER` owns the mission.
5. The lease belongs to both the actor and mission, is unrevoked, and has not expired.
6. The command itself has not expired.
7. The observatory reports a ready state through a trusted server-side source.
8. A server-side safety validator approves the command.

No browser claim may satisfy conditions 3–8. Future command handlers must load mission, lease, readiness, and safety results from trusted server-side repositories. After authorization, commands should enter a durable queue with an idempotency key and audit record. Only the observatory service may translate queued high-level actions into vendor-specific hardware commands.

## STRIDE threat model

| Threat                 | Scenario                                                                     | Mitigation                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Stolen or fabricated session cookie                                          | 256-bit opaque tokens, hashed database storage, expiry, secure cookies, server-side lookup                                   |
| Tampering              | Changed role, mission, lease, readiness, or safety values in the browser     | None of these values are trusted from the browser; server-side database and adapter checks are mandatory                     |
| Repudiation            | User denies authentication or control activity                               | Structured authentication audit events; future command queue must retain actor, mission, lease, policy result, and timestamp |
| Information disclosure | Password, token, telescope credential, or adapter secret reaches client code | Server-only modules, password/token hashes at rest, opaque cookies, no `NEXT_PUBLIC_` control secrets                        |
| Denial of service      | Credential stuffing or registration flood                                    | Persistent application rate limits plus required edge limits; bounded password and request inputs                            |
| Elevation of privilege | `USER` invokes an operator endpoint                                          | Database role checks at handler and service layers; explicit administrative-role allowlist; policy regression tests          |

## Security headers and deployment requirements

The production platform should terminate TLS and add HSTS, a restrictive Content Security Policy, `X-Content-Type-Options: nosniff`, a suitable `Referrer-Policy`, and frame protection through CSP `frame-ancestors`. Secrets belong in the deployment secret manager, not source control or `NEXT_PUBLIC_` variables. Rotate `AUTH_SECRET` and email webhook secrets through a documented process; rotating the authentication secret invalidates rate-limit/audit pseudonyms but does not expose existing sessions.

Database backups must be encrypted and access-controlled. Restrict the application database role to the Darkview schema. Production role changes require an audited administrative path; public registration always creates `USER`.

## Verification checklist before hardware integration

- Apply the Prisma migration and configure the email delivery webhook.
- Add edge rate limiting and production security headers.
- Exercise sign-up, verification, sign-in, session expiry, logout, and role-denial tests against a staging database.
- Implement a durable command queue and append-only command audit log.
- Implement observatory readiness and safety validators in the server-side adapter service.
- Prove that the browser bundle and network responses contain no telescope credentials.
- Require an operator-reviewed integration test before enabling any physical adapter.
