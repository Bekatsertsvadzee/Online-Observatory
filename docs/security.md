# Darkview security model

## Scope

This document covers the boundaries a reviewer has to check before trusting this
repository: account authentication, session management, authorization, the link between
the cloud and an observatory, the live-view surface, the money paths, and the rules that
stand between a request and a telescope.

It describes the platform half of Darkview — the API, the realtime service, the database
and the Observatory Agent. The website and the mobile application live in
`darkview-clients` and reach this repository only over HTTP.

**What talks to hardware, and what does not.** The Observatory Agent has real device
implementations: `AlpacaMount` over ASCOM Alpaca HTTP (DV-028) and `ZwoCamera` over the
ZWO ASI SDK (DV-029). The simulators remain the default in every environment, and no
first-party hardware has yet been commanded — DV-034 and DV-035, which measure the
optical train, have not run. Separately, and unchanged: `apps/api` never speaks to a
device at all. `RealObservatoryAdapter` in `apps/api/src/lib/observatory/real-adapter.ts`
throws on every operation by design, and `docs/observatory-protocol.md` governs it. The
API's path to a telescope is the realtime service and the agent, never a driver of its
own.

Companion documents: `docs/architecture.md` for how the system is assembled,
`docs/SAFETY.md` for the safety model in full, `docs/RUNBOOK.md` for the procedures, and
the approved records in `docs/decisions/`. Where this document and an approved ADR
disagree, `CLAUDE.md`'s order of precedence decides.

## Trust boundaries

1. **The browser is untrusted.** It may express bounded intent — book a slot, start a
   mission it owns, request a target — but it never mints a `CommandEnvelope`, never
   holds a device credential, never declares an observatory ready and never approves its
   own safety check. `commandId`, `sessionId`, `userId`, `issuedAt` and `expiresAt` are
   set by the cloud (`docs/architecture.md` §3).

2. **`apps/api` is the HTTP boundary.** Route handlers only; no UI lives here. Every
   state-changing request validates its origin and its inputs, and authorization is a
   server-side database read, never a browser claim (ADR-016).

3. **PostgreSQL is the source of truth** for users, roles, sessions, rate limits, audit
   events, bookings, missions, payments, ledgers and observatory records. A value that
   decides anything is read from it at the moment it decides.

4. **`apps/realtime` transports; it does not decide.** It holds the agent socket, the
   client fan-out and the live view, and it holds no business rules
   (`docs/architecture.md` §2). It is a separate always-on Node service because a
   serverless function cannot hold a long-lived socket.

5. **The observatory accepts no inbound connection**, from the internet or from the LAN.
   The agent dials out over authenticated WSS, keeps a heartbeat, reconnects on loss, and
   re-validates every command it receives. The single exception by design is the ASCOM
   Remote / Alpaca bridge, which listens on `127.0.0.1` only, for traffic between the
   agent and the mount driver on the same machine. It must never bind `0.0.0.0`, never be
   port-forwarded and never be reachable from another host.

6. **The agent does not trust the cloud.** It enforces idempotency by `commandId`,
   expiry, session ownership, mission ownership and the full safety envelope again,
   independently. A cloud-approved command that fails local safety is refused. Two
   implementations of the same rules mean a bug in one does not reach the mount.

7. **A partner observatory is a machine somebody else owns.** It is admitted by an
   operator-issued token and operated only while `APPROVED` under ADR-013. Registration,
   approval and token issuance are operator acts; nothing self-approves.

8. **Email delivery is a server-to-server webhook** out of the platform. Requests are
   signed with `EMAIL_VERIFICATION_WEBHOOK_SECRET`; the verification bearer token is
   never returned by the registration response.

9. **Payment settlement is a server-to-server webhook** into the platform.
   `POST /payments/webhook` has no session. What authenticates the caller is the
   provider's signature over the exact bytes of the body, checked in constant time before
   the body's contents are trusted. The sandbox provider signs with
   `PAYMENT_SANDBOX_WEBHOOK_SECRET` and is refused outright in production. A callback is
   then checked against the records — the payment it names, the provider it was opened
   with, the amount the intent was for — and only a callback that fits confirms a booking
   or funds a subscription. A refused callback leaves an audit row.

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

UI visibility is not authorization. `assertRole` and `requireRole` are server-only checks. Administrative command entry points must require `OPERATOR` or `ADMIN` at the handler and service layers. A `USER` request for an administrative command is rejected before any mission or session evaluation.

## The observatory link

The agent authenticates with exactly one credential: a device token, presented as
`Authorization: Bearer` on its outbound handshake. `authenticateAgent` in
`apps/realtime/src/auth/device-token.ts` hashes the presented token with SHA-256 and looks
up `Observatory.deviceTokenHash`. **A null hash admits no agent**, which is the state a
newly registered node is in.

An unauthenticated handshake is answered `401` with no detail: a caller learns nothing
about which part of the credential was wrong, or whether the observatory exists.

Per ADR-020:

- **Only an operator issues, rotates or revokes a token.** Issuing one is what lets a
  telescope onto the network, so it is an operator act, like approval.
- **Shown once, stored hashed.** The token appears in the issue or rotate response and
  nowhere else — not in an audit row, not in a log, not in any later read.
- **Issue refuses when a token exists; rotate refuses when none does.** Two operators
  cannot silently replace each other's token, and replacing one is always a named act.
- **A token grants a connection, not operation.** Nothing is operated on a node that is
  not `APPROVED`. Revocation is one row, and it is the emergency stop ADR-013 requires.

**One link per observatory.** A second connection presenting the same valid token is
closed; the incumbent keeps the observatory and is never disturbed by the attempt.

**The hello must agree with the token.** A valid token used to claim a different
observatory is a refusal, not a correction.

## The telescope command boundary

Authorization is server-side and fails closed. A command reaches a device only when all of
the following hold, and none of them may be satisfied by a browser claim:

1. The actor has a server-verified session (ADR-016), or is the agent presenting a valid
   device token.
2. The actor's database role permits the command category.
3. The mission exists, is in an operational state, and belongs to the observatory the
   command is relayed to.
4. The requesting session is the **current session owner**. One active mission at a time,
   one active session owner at a time.
5. The `CommandEnvelope` has not passed `expiresAt`.
6. The `commandId` has not already been seen — commands are idempotent, and a repeat is
   ignored rather than re-executed.
7. The cloud's safety pre-validation approves it.
8. **The agent's own safety validation approves it, independently.** This is the one that
   matters: a cloud-approved command that fails local safety is refused at the
   observatory.

Every minted command writes an audit row; every mission transition writes a `MissionEvent`
carrying its source (`CLOUD`, `AGENT`, `OPERATOR`).

The safety rules themselves — altitude envelope, horizon mask, Sun avoidance, the
watchdog, rule order, and what is not overridable — are `docs/SAFETY.md`, which governs
them. Two properties belong here because they are refusals, not settings:

- **`MAX_ALT_SAFE` is unmeasured until DV-034.** While
  `SafetyEnvelopeConfig.maxAltitudeDegrees` is null, both the cloud and the agent refuse
  every slew with `SAFETY_ENVELOPE_UNMEASURED`. A default value must never ship.
- **`HORIZON_MASK` is site-specific** (ADR-005, Tbilisi rooftop). A survey from anywhere
  else is not valid for this site.

An operator weather hold is enforced by the agent and keeps being enforced across a
reconnect (DV-039); it is not advisory state the cloud has to keep re-asserting.

**Observers have no command path at all.** The Observer Pack fans out in the cloud, and
the agent never learns an observer exists (ADR-007), so observer count cannot affect
safety, command validation or session ownership.

## The live-view surface

`GET /stream/mission/{missionId}` is the realtime service's only HTTP surface beyond the
upgrade handshake (ADR-011). It answers `multipart/x-mixed-replace` from the same origin.

**Three independent checks on every request**, not one:

1. the session cookie proves somebody is signed in;
2. a signed, short-expiry token proves the URL was minted for that same person, and bounds
   how long a copied `src` keeps working;
3. `mayWatchMission` proves they are *still* entitled.

Without the third, the token would be a bearer credential for its lifetime, and an
observer whose controller closed the mission would keep being served until it lapsed.

**Every refusal is the same 404** — not signed in, forged token, expired token, somebody
else's token, unknown mission, no frames yet, seat withdrawn. The mission channel already
refuses on that rule; a second surface answering more precisely would undo it.

**A frame is never persisted.** One JPEG per mission is held in the memory of the process
that received it, replaced on arrival, and released on mission end, on link loss and on
staleness. It never reaches disk, the database or object storage. The kept artefact is a
`Capture`.

## The WebSocket boundary

Both sockets — the agent link and the mission channel — are bounded, in three places
(DV-116):

- `contracts/openapi.yaml` caps `AgentLiveFrame.byteLength` at 4 MiB. The contract is what
  sets the size; the generated Zod and the generated Pydantic both enforce it, so an
  oversized header is refused by the cloud and cannot be constructed by the agent.
- `maxPayload` on the `WebSocketServer` is the transport refusing to buffer what the
  contract would reject anyway. `ws` buffers a whole message before any handler sees it,
  so without this every check would run on bytes already taken.
- JSON is bounded separately and much smaller (64 KiB), enforced as a parse failure, so an
  oversized message is answered and survived once online and closes the connection before
  hello or before subscribe — exactly like any other malformed input.

**Origin is checked before the cookie is read** on the mission channel. A WebSocket
handshake is not subject to the same-origin policy, so any page anywhere can open one and
the browser will attach the customer's cookies. `APP_URL` on the realtime service has no
default for this reason: a permissive fallback would silently disable the check.

This also constrains deployment. The session cookie is `__Host-` prefixed in production, so
the browser sends it only to the host that set it — **the realtime service must be served
from the same host as the web app, on a path, not on a `realtime.` subdomain.**

## Money, minutes and points

Three balances, three ledgers, no crossing: money (`Payment`), observation minutes
(`CreditLedger`, ADR-022) and loyalty points (`LoyaltyLedgerEntry`, ADR-008).

- **Nothing grants a balance outside a settlement transaction.** Minutes are written by
  `settleSubscriptionPayment` inside the transaction of a captured payment, keyed
  `renewal:<subscriptionId>:<periodStart>`, so a webhook delivered twice, a sweep on two
  processes and a retried charge converge on one grant.
- **Spending is conditional and transactional.** A minute or a point is claimed by a
  conditional update keyed to the booking, inside the reservation's transaction. A slot
  conflict rolls the claim back with the booking, and two bookings racing on one balance
  get only as many slots as it covers.
- **One price reduction per booking** — a voucher, points, or minutes.
- **The ledgers are append-only by database trigger**, not by application convention.
- **Nothing sells in production.** The sandbox provider is refused there, and no real
  provider adapter exists yet (ADR-022 §11).

## Partner observatories

ADR-013 is approved, and it replaces the attended-operator rule **for partner nodes only**.
First-party operation is unchanged and still requires an attended operator.

A partner node may operate unattended only while `APPROVED`, which requires a measured
envelope, sky-verified coordinates, a recorded horizon mask, a supervised first light and
Park proven on that hardware. It returns to refusing everything the moment any of those
stops holding. An operator can suspend it, or revoke its token in one row.

The gate is DV-124: a stranger's telescope cannot be certified with a procedure Darkview
has never run on its own instrument, so nothing accepts a customer on a partner node until
the first-party qualification (DV-034) has been performed.

The transport needs nothing new. The agent is already software-only, already outbound-only,
and already holds one revocable token scoped to one observatory.

## STRIDE threat model

| Threat | Scenario | Mitigation |
| --- | --- | --- |
| Spoofing | Stolen or fabricated session cookie | 256-bit opaque tokens, hashed at rest, expiry, `__Host-` secure cookies, server-side lookup on every request |
| Spoofing | Stolen device token used to impersonate an observatory | SHA-256 comparison against one observatory row; hello must agree with the token; one link per observatory; operator-only rotate and revoke (ADR-020) |
| Spoofing | A page elsewhere opening a mission channel with the customer's cookies | Origin checked before the cookie is read; `APP_URL` has no default |
| Tampering | Role, mission, ownership, readiness or safety values changed in the browser | None are trusted from the browser; all are server-side database reads at the moment they decide |
| Tampering | A command altered in transit to the observatory | The realtime service transports and does not rewrite; the agent re-validates the envelope independently and refuses on its own safety rules |
| Tampering | A forged or replayed payment callback | Provider signature over the exact body, constant-time, checked before the body is trusted; then matched against the payment, provider and amount on record |
| Repudiation | An actor denies a command or a transition | Every minted command writes an audit row; every transition writes a `MissionEvent` with its source; refused callbacks leave an audit row; nothing is backdated |
| Information disclosure | A credential reaching client code | Server-only modules; password, session and device tokens hashed at rest; the device token shown once and never re-read; no `NEXT_PUBLIC_` control secrets |
| Information disclosure | Probing for missions, observatories or seats by id | Uniform refusals: the stream surface answers one 404 for every reason, and the mission channel words every refusal identically |
| Denial of service | Credential stuffing or registration flood | PostgreSQL-backed rate limits on the identity flow, plus required edge limits |
| Denial of service | An oversized WebSocket message from a token holder | Contract bound on `byteLength`, `maxPayload` on the transport, a separate small bound on JSON (DV-116) |
| Elevation of privilege | A `USER` invoking an operator endpoint | Database role checks at handler and service layers, an explicit administrative allowlist, and policy regression tests |
| Elevation of privilege | A registered node operating before it is qualified | A token grants a connection, not operation; nothing is operated on a node that is not `APPROVED` (ADR-013, ADR-020) |
| Elevation of privilege | A cloud bug approving an unsafe slew | The agent validates again and refuses; `MAX_ALT_SAFE` unmeasured refuses every slew on both sides |

## Security headers and deployment requirements

The production platform should terminate TLS and add HSTS, a restrictive Content Security
Policy, `X-Content-Type-Options: nosniff`, a suitable `Referrer-Policy`, and frame
protection through CSP `frame-ancestors`. Secrets belong in the deployment secret manager,
not in source control and not in `NEXT_PUBLIC_` variables.

Required, with no safe default:

- `APP_URL` on the API — the exact public HTTPS origin, for the origin check.
- `APP_URL` on the realtime service — the only origin a mission-channel handshake may come
  from.
- `EMAIL_VERIFICATION_WEBHOOK_URL` and `EMAIL_VERIFICATION_WEBHOOK_SECRET` (at least 32
  characters) before registration is enabled.

If a reverse proxy is used it must replace rather than append untrusted forwarding
headers. Add an IP/device-level rate limit at the edge: the application limit protects the
identity flow and is not a substitute for upstream denial-of-service controls. Periodically
delete expired sessions, consumed or expired verification tokens, old rate-limit buckets
and audit events according to the retention policy.

Rotate `AUTH_SECRET` and the webhook secrets through a documented process; rotating the
authentication secret invalidates rate-limit and audit pseudonyms but does not expose
existing sessions. Database backups must be encrypted and access-controlled, and the
application database role restricted to the Darkview schema. Production role changes
require an audited administrative path; public registration always creates `USER`.

## Dependency advisories

Triaged 2026-09-14, from the P2 finding in `docs/audits/2026-09-13-review.md`. `npm audit`
reports eight high-severity packages, four of them with `--omit=dev`. None is fixed by an
upgrade the version policy allows, and none is reachable from a request.

| Package | Installed | Reached through | When it runs | Reachable from a request |
| --- | --- | --- | --- | --- |
| `js-yaml` | 4.2.0 | `@hey-api/openapi-ts` 0.99.0 → `@hey-api/json-schema-ref-parser` 1.4.4 | `contracts:generate` and `contracts:check`, parsing this repository's own `contracts/openapi.yaml` | No |
| `deepmerge-ts` | 7.1.5 | `prisma` 7.9.1 → `@prisma/config` 7.9.1 | The Prisma CLI loading `packages/db/prisma.config.ts` | No |
| `mysql2` | 3.15.3 | `prisma` 7.9.1 | Never: the datasource is PostgreSQL | No |
| `prisma`, `@prisma/config`, `@hey-api/openapi-ts`, `@hey-api/json-schema-ref-parser`, `@hey-api/shared` | — | the three above | as above | No |

**Why nothing is patched.**

- `npm audit fix` proposes `prisma` 6.19.3 and `@hey-api/openapi-ts` 0.97.0. Both are
  major downgrades, which the version policy forbids mid-phase.
- The newest releases inside the pinned majors do not help. `prisma` 7.10.0 pins the same
  `mysql2` 3.15.3 and, through `@prisma/config` 7.10.0, the same `deepmerge-ts` 7.1.5.
  `@hey-api/openapi-ts` 0.99.0 is the latest release and pins `js-yaml` 4.2.0 exactly.
- Every vulnerable version is an exact pin in its parent. An `overrides` entry would run
  those tools on a dependency their authors did not release them with, and for
  `deepmerge-ts` that is a major version. Not done.

**Why the production audit still lists Prisma.** `prisma` is a devDependency of
`packages/db`, and an *optional* peer of `@prisma/client`. Because the workspace install
contains it, `npm ls --omit=dev` shows it under both services. A production install that
omits `packages/db`'s dev dependencies would not contain it, which is to be confirmed when
hosting is chosen. Migrations (`prisma migrate deploy`) then run from an install that has
it, not from the service image.

**When to look again:** any release of `prisma` 7.x or `@hey-api/openapi-ts` that changes
these pins, any advisory against a package that runs while handling a request, and the
hosting decision.

## Verification checklist before first-party hardware operation

The gate is DV-034, the attended mount qualification that measures `MAX_ALT_SAFE` from the
assembled optical train. Nothing below substitutes for it.

- `MAX_ALT_SAFE` measured on the physical optical train and recorded, never defaulted.
- `HORIZON_MASK` surveyed at the installation site (ADR-005), not imported.
- Park proven on the real mount, and proven again from each failure path.
- Sun avoidance exercised against the real ephemeris at the real site.
- The agent's independent refusal demonstrated: a cloud-approved command that fails local
  safety is refused at the observatory, with evidence.
- Heartbeat loss, device fault and operator abort each shown to stop capture, halt unsafe
  motion and Park (DV-037).
- The Alpaca bridge confirmed bound to `127.0.0.1`, not port-forwarded, and unreachable
  from another host on the LAN.
- Device token issued by an operator, shown once, and revocation confirmed to drop the
  link.
- Edge rate limiting and production security headers in place.
- Sign-up, verification, sign-in, session expiry, sign-out and role-denial exercised
  against a staging database.
- The browser bundle and network responses proven to carry no telescope credential.
- An operator-reviewed integration run before any physical device is enabled.

A partner node adds ADR-013's own requirements on top of these, and cannot be qualified
until the first-party qualification has been performed (DV-124).
