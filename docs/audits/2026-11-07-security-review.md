# Security review and bug hunt — 7 November 2026

Reviewer: Claude (Opus 5.5), working as an external tester for the maintainer. This
report is the deliverable; nothing here was committed, pushed or deployed.

## Scope

- Repository: this platform repository (`part-1-platform`), working tree at
  `321a456e8bc62e17ecadbf54114721c552ae77d6` (main), plus the untracked `merge212/`
  directory for the secret scan only. The clients repository was not reviewed.
- Areas: authentication, sessions, authorization/IDOR, money/minutes/points, booking
  and time, the realtime service (mission channel, live stream, agent link), the
  Observatory Agent's command validation and safety envelope (by reading and by the
  simulator suite only), input handling, abuse limits, deletion and privacy, and
  `deploy/fly`.
- Not done, by the hard limits: no request to any host not started locally, no REAL
  mode, no device, no `db:migrate`, no git write, and in the first pass no contract change (the second pass made one on the maintainer's instruction). Read-only git
  (`git log`, `git ls-files`, `git rev-parse`, and gitleaks' own `git log`) was used for
  the commit hash and the history scan, which the brief asked for.
- Database: a disposable PostgreSQL 16.15 cluster initialised in a scratch directory on
  `127.0.0.1:55441`, database `darkview_test`. `DATABASE_URL` and `DATABASE_TEST_URL`
  were exported to it, so the local `.env` (whose hosts are all localhost) supplied
  nothing to the database.

### Tools

| Tool | Version |
| --- | --- |
| Node / npm | 24.14.1 / 11.11.0 |
| Python | 3.12.14 |
| PostgreSQL | 16.15 (Homebrew) |
| vitest / fast-check | 4.1.11 / 3.23.2 |
| pytest / hypothesis / ruff | 8.4.2 / 6.140.3 / 0.14.4 |
| gitleaks | 8.30.1 (`--redact=100`) |
| pip-audit | 2.10.1 |
| npm audit | npm 11.11.0, `--omit=dev` |

## Test counts

| Step | Baseline (before any change) | Final (after fixes) |
| --- | --- | --- |
| Contract drift | pass | pass |
| ESLint | pass | pass |
| Ruff (agent) | pass | pass |
| Typecheck | pass | pass |
| Unit — API | 708 passed | 717 passed (+9 property tests) |
| Unit — realtime | 463 passed | 465 passed (+2) |
| Integration — API (PostgreSQL) | 662 passed, 1 skipped | 667 passed, 1 skipped (+5) |
| Integration — realtime (PostgreSQL) | 92 passed | 92 passed |
| End-to-end | 1 passed | 1 passed |
| pytest (agent, simulator) | 1037 passed | 1044 passed (+7) |
| Build | pass | pass |
| **Total tests** | **2,963 passed, 1 skipped** | **2,986 passed, 1 skipped** |

Nothing was red before work started, so there is no "finding #1" from the baseline.

Flakiness: the integration suite (API + realtime + e2e) was run five more times
back to back, with this review's tests included. All five passed identically
(667 passed + 1 skipped, 92, 1). No flaky test was found. The one skipped API test is
skipped on purpose in its own file and was skipped in the baseline too.

## Findings

Severity follows the brief. Status: **fixed** (failing test written first, then the
smallest fix), **proposal** (needs a decision, a contract change, a dependency change or
an ADR), **accepted** (recorded, no change recommended now).

| ID | Sev | Area | Where | How to reproduce | Status | Proving test |
| --- | --- | --- | --- | --- | --- | --- |
| SR-01 | CRITICAL | A — auth | `apps/api/src/features/auth/google.ts:146` | Register a stranger's address with a password of your choosing (it stays unverified). When its owner later uses "Continue with Google", the account is linked and verified — and your password still signs in to it. Pre-account takeover. The reset path (ADR-040) already guards this case; the Google path (ADR-048) did not. | fixed | `google.integration.test.ts` › "drops the password somebody else chose for an address they never verified"; "keeps the password of an account that had already verified its address" |
| SR-03 | HIGH | F — observatory link | `apps/realtime/src/server.ts` (pending sweep), `apps/realtime/src/auth/device-token.ts` | Connect an agent, then revoke or rotate its token while the LISTEN connection is down (the NOTIFY is lost). Before: the revoked agent kept the observatory for as long as its socket stayed up — revocation is the emergency stop ADR-013/ADR-020 rely on. After: the 15-second sweep re-checks the token each link was admitted with and closes it, before relaying any command. | fixed | `server.test.ts` › "a token revoked while the notification is lost" (2 tests) |
| SR-05 | MEDIUM | F — observatory link | `agent/darkview_agent/config.py` (`_cloud_url`), `agent/darkview_agent/setup.py:67` | `DARKVIEW_AGENT_CLOUD_URL=ws://cloud.example/ws/agent`: `setup --check` refused it, but the agent itself started on it and the setup prompt accepted it — device token and every command in clear text. Now: `wss://` only, or `ws://` to a loopback literal (the demo's in-machine link). | fixed | `test_config.py` › `test_the_agent_refuses_an_unencrypted_or_unknown_cloud_url` (4 cases), `test_the_agent_accepts_wss_and_loopback_ws` (3 cases); `test_setup.py` › `test_the_check_refuses_an_unencrypted_cloud_url` (assertion reworded, still exit 2) |
| SR-02 | MEDIUM | A — enumeration | `apps/api/src/features/auth/authenticate.ts:172` | `POST /auth/register` with a verified address returned before any scrypt work (~100 ms faster than a new address). The 202 was uniform; its timing was not. Now every branch derives the hash once. Residual: a new or unverified address also waits for email delivery — see P-02. | fixed (residual → P-02) | `authenticate.integration.test.ts` › "does the same scrypt work for a known address as for a new one" |
| SR-04 | MEDIUM | I — deletion | `apps/api/src/features/auth/deletion.ts` | Join a waiting list, delete the account. The place stayed WAITING; the sweep later offered it a freed slot, held that slot from every other customer for the offer's 15 minutes, and queued an email to `deleted-…@deleted.invalid`. | fixed | `deletion.integration.test.ts` › "takes the account off every waiting list" |
| SR-06 | MEDIUM | H — abuse | `apps/realtime/src/server.ts` upgrade handler | Open `/ws/agent` repeatedly with random bearer tokens: each attempt is an unauthenticated database lookup, unmetered. `/ws/mission/*` likewise does a session lookup per attempt. No limit at the Caddy front either. | fixed 2nd pass (in-flight cap; per-address limit still needs P-03) | `server.test.ts` › "refuses handshakes past the cap without asking the store" |
| SR-07 | MEDIUM | A/H — lockout | `apps/api/src/lib/security/rate-limit.ts` (`requestActor`) | With `TRUSTED_PROXY_HOPS=0` (the documented value behind Vercel), the sign-in bucket key is `unattributed:<email>`. Five wrong passwords for a named customer lock them out of web and native sign-in for 15 minutes, repeatable indefinitely; registration has no per-client cap at all. Documented trade-off, but its consequence for a targeted customer is not written down. | documented 2nd pass (`docs/security.md` § Rate limiting); needs `TRUSTED_PROXY_HOPS` set — P-04 | — |
| SR-08 | MEDIUM | deps | `package-lock.json` | `zod` 4.4.3 < 4.6.6, GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized constrained collections). Reachable: every JSON body is parsed by generated Zod and route handlers set no body-size limit. Fixed inside major 4. | fixed 2nd pass (zod 4.6.7) | full suite + `npm audit --omit=dev`: 0 high |
| SR-09 | LOW | deps | `package-lock.json`, `agent/requirements-dev.txt` | `npm audit --omit=dev`: prisma/@prisma/config/deepmerge-ts/mysql2 (high) now have an in-major fix, `prisma@7.10.1`, which contradicts `docs/security.md` § Dependency advisories ("the newest releases inside the pinned majors do not help"); `@sentry/*` 11.7.0 → 11.11.0 (glob/minimatch, build time); `fast-uri` (lockfile refresh). pip-audit: `pillow` 11.3.0 has 18 advisories fixed only in 13.0.0 (major; the agent only encodes its own frames, never decodes input); `pytest` 8.4.2 (dev only). | fixed 2nd pass (prisma 7.10.1, fast-uri 3.1.9, `security.md` updated); Sentry and Pillow deferred, see 2nd pass | `npm audit --omit=dev`: 5 moderate, build-time only |
| SR-10 | LOW | I — privacy | `apps/api/src/features/auth/deletion.ts:157` | A Google-only customer has no `Account` row, so `DELETE /me` (which requires `currentPassword`) always answers "current password is incorrect". They must first get a password through the reset link. SR-01 makes more accounts passwordless. | proposal P-05 (contract) | — |
| SR-11 | LOW | C — points | `packages/db/loyalty.ts:274`, `reverseLoyaltyForRefund` | The referral bonus (both sides) is granted on the referee's first paid booking and is not reversed when that booking is refunded through an entitlement. Needs a lost slot, so not attacker-driven; policy question. | proposal P-06 | — |
| SR-12 | LOW | J — headers | `deploy/fly/Caddyfile`, `apps/api/next.config.ts` | No HSTS anywhere in the stack, and the Caddy front adds no headers to realtime responses (MJPEG stream, `/healthz`). `docs/security.md` asks for HSTS. | fixed 2nd pass | `apps/api/src/security-headers.test.ts`; Caddyfile `caddy validate` + local run |
| SR-13 | LOW | contract | `apps/api/src/app/health/route.ts` | `GET /health` is implemented and not in `contracts/openapi.yaml` — the only route/contract mismatch (83 spec paths, 84 implemented; every spec operation is implemented). | fixed 2nd pass (contract + generated code) | `apps/api/src/app/health/route.test.ts`; `contracts:check` |
| SR-14 | LOW | docs conflict | `docs/security.md` § CSRF vs `apps/api/src/lib/auth/api-guard.ts` | The document says authenticated mutations "additionally require the session-bound CSRF token". `requireApiMutation` checks Origin (fail-closed) and the CSRF *cookie* matches its stored hash, but no submitted token is compared — a cookie the browser attaches itself is not a CSRF control. The Origin check is sufficient in practice; the document and the code disagree. Reported, not resolved (CLAUDE.md). | fixed 2nd pass (`docs/security.md` now describes the code) | — |
| SR-15 | LOW | hygiene | `apps/api/src/lib/auth/admin-routes-guarded.test.ts` | The guard test matches substrings, so a comment containing `requireOperator` satisfies it, and its mutating-route regex only sees `export async function POST`. Every route today does use the right guard (checked by hand for all 19 admin routes). | fixed 2nd pass | `admin-routes-guarded.test.ts` › "puts every mutating admin route behind the operator mutation guard", "reads guards from code, not from comments" |
| SR-16 | LOW | H — abuse | `app/card-draws/[drawId]/pick/route.ts`, `app/votes/route.ts` | Unmetered mutations; each is bounded to one effect per user per week by a unique index. | accepted | — |
| SR-17 | LOW | E — agent | `agent/darkview_agent/supervisor.py:1146` (`_execute_nudge`) | The validator checks a NUDGE's landing point from one mount reading; the executor re-reads and slews without re-checking. A tracking mount drifts between the two reads by far less than one step, and a slewing mount is refused. Not a bypass; worth confirming with DV-034's real drift numbers. | fixed 2nd pass (executor re-checks the envelope) | `test_supervisor.py` › `test_a_nudge_is_judged_again_on_the_position_it_is_carried_out_from` |
| SR-18 | LOW | F — Windows | `agent/darkview_agent/setup.py:130` | `os.chmod(path, 0o600)` on Windows only toggles read-only; it sets no ACL. The token file is protected only because the default path is under the user profile. An `DARKVIEW_AGENT_ENV_FILE` under e.g. `C:\ProgramData` inherits that folder's ACL. | fixed 2nd pass (icacls owner-only ACL on Windows) | `test_setup.py` › `test_on_windows_the_file_gets_an_owner_only_acl_before_the_token_is_written` |
| SR-19 | LOW | I — logs | `packages/monitoring/scrub.ts` | The Sentry scrubber has no IP-address pattern; an exception message quoting `x-forwarded-for` would carry the address. `sendDefaultPii: false`, user/request/server_name are stripped, emails and tokens are scrubbed. | fixed 2nd pass | `apps/realtime/src/ops/monitoring.test.ts` (3 address cases + a keep-timestamps case) |
| SR-20 | LOW | hygiene | `.env` (working tree only) | Gitignored and never committed (history checked), but it holds a Telegram bot token and Codex settings unrelated to this project. Not a committed secret; consider moving them out. | accepted | — |

No committed secret was found. gitleaks over 229 commits reported two `generic-api-key`
hits, both test fixtures (`apps/realtime/src/internal/http.test.ts:22`,
`apps/api/src/lib/vouchers/codes.test.ts:11`); the working-tree scan additionally hit
only gitignored files (`.env`, `apps/api/.next/**` build output) and copies of the same
fixtures under `merge212/`. No `.env`, key or token file was ever added in history.

### What was tried and held (no finding)

- **Hardware safety (E).** Every call that moves the mount — `_do_preparing`, centring
  (`_correction`), ADR-080 re-centre, RETARGET, NUDGE, GOTO — passes
  `evaluate_pointing` first; PARK/ABORT are the only exemptions, by design. The validator
  re-checks expiry, session, user, mission, payload kind, weather hold, disarm, and the
  envelope independently of the cloud; Sun exclusion and daylight lock have floors that
  a configured value cannot open; a simulator-marked envelope is UNMEASURED on real
  drivers; a non-finite position refuses. The mission channel accepts only
  `CLIENT_SUBSCRIBE`/`CLIENT_PING` and has no command path; observers cannot mint
  commands (`mintMissionCommand` requires the session owner); a client cannot mint
  envelope fields or name GOTO/FOCUS/PARK/SET_PROFILE. No bypass found.
- **Agent link (F).** Token hashed and looked up; hello must match the token's
  observatory; one link per observatory; mission events, acks, upload grants and capture
  keys are all bound to the link's observatory, and capture keys are re-derived, never
  trusted. No listening socket in the agent; Alpaca host forced to a loopback literal.
- **Authorization (B).** Every non-public route uses a session guard; every `/admin/*`
  route requires OPERATOR (and the mutating ones Origin as well); every id-taking route
  scopes by owner in the query (bookings, captures, downloads, missions, events, watch,
  observers, broadcast, payments/checkout, sandbox checkout, card draws, waitlist,
  network nodes, vouchers, entitlement refund/reschedule).
- **Money (C).** Points, vouchers, minutes, prizes, slot reservation, settlement replay
  and observer seats already had Promise.all race tests; one reduction per booking is
  enforced; `loyaltyPoints` is an integer ≥ 100 in steps of 100 and capped so the total
  stays ≥ `minimumPayableMinor`; self-referral is refused. Added: two refunds racing on
  one entitlement (exactly one wins, ledger balances).
- **Input (G).** Request bodies are `strictObject` (unknown fields rejected; 176 strict
  schemas, the 63 loose ones are path/query/header objects). No `$queryRawUnsafe` outside
  tests; production raw SQL is tagged-template. No SSRF: every outbound fetch goes to a
  fixed or env-configured host. Email HTML is escaped and sent as JSON (no header
  injection).
- **Tokens (A).** Verification, reset and email-change tokens: 256-bit, hashed, 30-minute,
  consumed by a conditional update, bound to their row. Stream tokens: HMAC, constant-time,
  5-minute. Internal endpoint: constant-time over digests, uniform 404.
- **Indexes / N+1.** Hot lookups are indexed. One N+1 (`listMyWaitlistEntries` position),
  bounded at three rows.

### Bug hunt beyond security (step 4)

- Property tests added in `apps/api/src/lib/slots/slot-maths.property.test.ts` (9
  properties): slots are aligned, inside darkness, at the asked length and priced
  per minute; an available slot never clashes; nothing before `now` is available; the
  clash rule is symmetric and holds the turnaround on both sides to the minute; prices
  are whole, positive, monotonic; a close refund is within [0, price]; points earned are
  whole and within the rate; tiers are the highest reached; `localWallClockToUtc` lands
  on the asked local hour in Tbilisi (fixed UTC+4) and in DST zones. All pass — no
  defect found by them.
- Observation: one run of the new entitlement race test printed pg's "Calling
  client.query() when the client is already executing a query is deprecated" warning;
  five reruns did not reproduce it. pg@9 turns this into an error, so it is worth one
  look for a `Promise.all` inside a transaction on the refund path.
- `agent/tests/test_safety_properties.py::test_coordinates_stay_in_range` raises a
  `HypothesisDeprecationWarning` for using `random` inside a strategy (raised in the final run, not the baseline: it depends on the examples drawn). A shrunk failure
  from such a strategy may not replay, which matters for a safety property test.
- Timers: the realtime `setInterval`s in the process entry are process-lifetime; those
  in `createRealtimeServer` are cleared by `close()`. Unhandled rejections: every sweep,
  socket handler and upgrade path in `server.ts` catches.

## Proposals needing your decision

- **P-01 Dependencies (SR-08, SR-09).** Bump `zod` to ≥ 4.6.6 (in major) and regenerate
  contracts; bump `prisma`/`@prisma/client`/`@prisma/adapter-pg` to 7.10.1 (in major) and
  update `docs/security.md` § Dependency advisories, whose "no in-major fix" no longer
  holds; `@sentry/nextjs`/`@sentry/node` to 11.11.0; refresh the lockfile for `fast-uri`.
  Pillow 13 is a major upgrade on the agent: schedule it, not urgent. Not done here: each
  changes the lockfile and generated code and needs `npm install` from the network.
- **P-02 Auth email off the request path (SR-02 residual).** Registration and password
  reset still wait for email delivery on a new/known address and not on the others, so
  timing still separates them, by delivery latency. Queuing these through the existing
  outbox (the realtime dispatcher) would make every branch answer at the same speed. An
  architectural change: ADR.
- **P-03 WebSocket connect limits (SR-06).** Either an edge limit in front of
  `/ws/*` (Caddy has no rate-limit module in the stock image; Fly does not provide one),
  or an in-process per-address token bucket before `authenticateAgent` /
  `authenticateClient`. Needs the trusted client address on Fly (`Fly-Client-IP`), which
  is a deployment decision.
- **P-04 Lockout (SR-07).** Decide whether sign-in should count only failed attempts
  and/or key by address where one is trustworthy, and record the targeted-lockout
  consequence of `TRUSTED_PROXY_HOPS=0` in `docs/security.md`.
- **P-05 Deleting a passwordless account (SR-10).** `DeleteAccountRequest` needs another
  proof for an account with no password (a fresh Google sign-in, or an emailed
  confirmation link). Contract change.
- **P-06 Referral bonus on refund (SR-11).** Should a refunded first booking claw the
  referral bonus back (`REFERRAL_REVERSED`, a new ledger kind — schema change)?
- **P-07 HSTS (SR-12).** Add `Strict-Transport-Security` (and `X-Content-Type-Options`)
  in the Caddy front for every response, or in the API's `headers()`.
- **P-08 `GET /health` in the contract (SR-13).** Add it with `security: []`, or remove
  the route.
- **P-09 CSRF wording (SR-14).** Either change `docs/security.md` to say the Origin check
  is the CSRF control for JSON routes, or add a submitted-token comparison to
  `requireApiMutation` (which the clients would have to send).
- **P-10 Windows token file (SR-18).** Have the installer set an explicit ACL
  (`icacls … /inheritance:r /grant:r %USERNAME%:F`) or refuse an env-file path outside
  the user profile on Windows.

### Behaviour change to be aware of (SR-01)

A customer who registered with a password, never verified, and then signs in with Google
now loses that password (as a password reset would replace it). If they want one, the
reset link sets it. ADR-048 §2 says an unverified account "is verified by this" and is
silent on its password; this fix follows ADR-040's reasoning for the same case. An
amendment line in ADR-048 would make that explicit.

## Before hardware runs unattended

Cross-checked against `docs/security.md` § "Verification checklist before first-party
hardware operation". Nothing in this review substitutes for DV-034.

| Checklist item | State after this review |
| --- | --- |
| `MAX_ALT_SAFE` measured on the optical train | Open (DV-034). Code refuses every slew while null, on both sides — verified by reading and tests. |
| `HORIZON_MASK` surveyed at the site | Open. |
| Park proven on the real mount, from each failure path | Open. Simulator only. |
| Sun avoidance against the real ephemeris at the site | Open on hardware. Code floors verified. |
| Agent's independent refusal demonstrated with evidence | Verified in code and in the simulator suite; hardware evidence open. |
| Heartbeat loss / fault / abort stop, halt, Park (DV-037) | Open on hardware. |
| Alpaca bridge on 127.0.0.1 only, unreachable on the LAN | Agent side enforced in code (loopback literal). The bridge's own binding and the LAN check are open — a physical check. |
| Device token issued once, revocation drops the link | Now holds even when the NOTIFY is lost (SR-03). Still to be shown on the deployed stack. |
| Edge rate limiting and production security headers | **Not in place** — SR-06 (P-03), SR-12 (P-07). |
| Sign-up … role-denial exercised against staging | Open (only the scratch database here). |
| Browser bundle and responses carry no telescope credential | Clients repository — not reviewed here. API/realtime responses checked: the device token is shown only in the issue/rotate response. |
| Operator-reviewed integration run before a device is enabled | Open. |

Added by this review for the agent's host: `DARKVIEW_AGENT_CLOUD_URL` must be `wss://`
(now enforced, SR-05), and the token file's location/ACL on Windows (P-10).

## Files changed

Code:
- `apps/api/src/features/auth/google.ts` — SR-01
- `apps/api/src/features/auth/authenticate.ts` — SR-02
- `apps/api/src/features/auth/deletion.ts` — SR-04
- `apps/realtime/src/server.ts`, `apps/realtime/src/auth/device-token.ts` — SR-03
- `agent/darkview_agent/config.py`, `agent/darkview_agent/setup.py` — SR-05

Tests:
- `apps/api/src/features/auth/google.integration.test.ts` (+2)
- `apps/api/src/features/auth/authenticate.integration.test.ts` (+1, and a counting
  wrapper around `hashPassword` that leaves its behaviour unchanged)
- `apps/api/src/features/auth/deletion.integration.test.ts` (+1)
- `apps/api/src/features/booking/entitlement.integration.test.ts` (+1, race)
- `apps/api/src/lib/slots/slot-maths.property.test.ts` (new, 9)
- `apps/realtime/src/server.test.ts` (+2), `apps/realtime/src/link/fake-store.ts`
  (`forgetToken` test helper)
- `agent/tests/test_config.py` (+7 cases), `agent/tests/test_setup.py` (one assertion
  reworded: the refusal now comes from the configuration, still exit 2)

This report: `docs/audits/2026-11-07-security-review.md`.

## Second pass — 8 November 2026 ("fix all bugs")

The maintainer asked for every bug to be fixed. That instruction is taken as the approval
the first pass waited for on the contract change (SR-13) and the in-major dependency
bumps. The hard limits still held: no `db:migrate`, no schema change, no git write, no
request to a project host, no REAL mode. Each code fix again started from a failing test.

Fixed: SR-06, SR-08, SR-09 (in part), SR-12, SR-13, SR-14, SR-15, SR-17, SR-18, SR-19
— see the Status column above. SR-07 is now documented in `docs/security.md`.

What changed, beyond the table:

- **Dependencies.** `zod` 4.4.3 → 4.6.7, `prisma`/`@prisma/client`/`@prisma/adapter-pg`
  7.9.1 → 7.10.1, `fast-uri` 3.1.8 → 3.1.9 (lockfile only). Both were released 2–4 weeks
  before the bump. `npm audit --omit=dev`: 6 moderate + 5 high → 5 moderate, all
  `@sentry`/`glob`/`minimatch` at build time. Not taken: `@sentry/*` 11.11.0 (published
  two days before; take it after a fortnight), Pillow 13 and pytest 9 (major upgrades,
  which the version policy keeps out of this phase).
- **A regression the Prisma bump caused, caught and fixed (SR-21).** Prisma 7.10.1's
  adapter maps PostgreSQL deadlocks (40P01) and serialization failures (40001) to its own
  `P2034` and no longer passes the SQLSTATE through. `retryOnDeadlock` in
  `apps/api/src/features/booking/reserve.ts` keyed off the raw 40P01, so after the bump
  a deadlock-victim reservation failed with a 500 instead of being re-run. Three
  existing race tests went red ("answers every lost race with a 409, never a deadlock",
  and the minutes and voucher races against a cash booking). `isDeadlock` now accepts
  either form; all three pass. `deletion.ts` already accepted `P2034`. Nothing else reads
  the SQLSTATE of a retryable error.
- **pg deprecation warning, located.** Traced with `--trace-deprecation`: the second
  concurrent query is issued inside Prisma's own transaction runtime
  (`PgTransaction.performIO`), during the race tests, not by project code. Upstream; keep
  `pg` below 9 until Prisma's adapter stops doing it.
- **Contract.** `GET /health` and a `ServiceHealth` schema added to
  `contracts/openapi.yaml`; generated TypeScript, Zod and Pydantic regenerated (additive
  only). `part-2-clients/packages/contracts/openapi.yaml` needs the new copy and
  `npm run contracts:generate` there (README, "The one rule").
- **SR-17 is a hardware-path change.** `_execute_nudge` now judges the landing point it
  actually slews to against the envelope, after the validator has already judged the
  landing point it saw. The reproducing test makes the validator's reading stale (50°)
  while the mount sits at 56.66° under MAX_ALT_SAFE 57°. Before the fix the executor
  slewed the simulated mount to 57.16°. Simulator only; no device was touched.
- **SR-06** caps upgrades waiting on their credential lookup at 32; past that a handshake
  gets 503 without a database read. Links already open are never touched. A per-address
  limit still needs a trustworthy client address (P-03).
- **SR-18** runs `icacls <file> /inheritance:r /grant:r <user>:F` on Windows, on the empty
  temporary file, before the token is written. Tested with the platform and
  `subprocess.run` patched; it has not run on a real Windows machine.

Looked into and not a bug:

- `Promise.all` inside a transaction (`readLoyaltyScheme(tx)`, the deletion blockers).
  Prisma queues those queries itself; a test of both paths passed unchanged and was
  removed rather than kept as a test of nothing. The pg warning has the upstream cause
  above.
- The `HypothesisDeprecationWarning` in `test_safety_properties.py`. That file is clean
  run alone with the warning as an error. `websockets` uses `random` for its reconnect
  backoff, so a client left reconnecting by an earlier link test is what trips it: test
  hygiene, worth finding, not a product defect.

Still needs your decision (no code written):

- **P-02 — auth email timing.** Closing the residual means either dropping the tested
  "503, so the customer can try again" on a failed delivery (send after the response), or
  holding every register/reset/email-change answer to a fixed floor (about 1.5 s).
- **P-03 — per-address WebSocket limit** needs the client address Fly hands Caddy to be
  trusted: a deployment decision.
- **P-04 — `TRUSTED_PROXY_HOPS`** set for the real proxy chain, which is what removes the
  targeted lockout.
- **P-05 — deleting a passwordless account.** Needs a contract change to
  `DeleteAccountRequest` and a choice of proof (a fresh Google sign-in, or an emailed
  link). Not designed here because deletion cannot be undone.
- **P-06 — referral bonus on refund.** Policy, and a reversal would need a new ledger kind
  (schema change).
- **ADR-048 amendment** for SR-01's behaviour, and the local `.env`'s unrelated Telegram
  token (SR-20) — yours to move.

Second-pass test counts: contract drift, ESLint, Ruff, typecheck and build pass; unit API
721 (+4), unit realtime 470 (+5), integration API 667 + 1 skipped, integration realtime
92, end-to-end 1, pytest 1046 (+2) — **2,997 passed, 1 skipped** against the baseline's
2,963. The integration suite ran green twice more after the SR-21 fix.
