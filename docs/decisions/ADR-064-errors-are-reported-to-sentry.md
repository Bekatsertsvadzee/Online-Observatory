# ADR-064 — Errors Are Reported to Sentry, Scrubbed, and Only When Configured

- **Date:** 2026-10-23
- **Status:** APPROVED (maintainer's standing approval for Phase 6 scope records, given
  2026-10-23; open to revision on review)
- **Decided by:** project maintainer
- **Relates to:** Phase 6 plan, slice 6.0 ("we hear about errors before a customer does");
  CLAUDE.md "Security and audit"; platform ADR-035 (the hosted demo)

## Context

The hosted demo went down on 2026-10-22 when its free database plan was suspended. Nobody
knew until the maintainer opened the site. Every part of Stellar logs errors to its own
console — the website and the API on Vercel, the realtime service and the simulated agent
on Fly, the agent on the observatory mini-PC later — and nobody reads those consoles.

## Decision

### 1. One tool: Sentry, free plan

Sentry has official SDKs for all four runtimes we have (Next.js for the website and the
API, Node for realtime, Python for the agent), a free plan large enough for a demo (5,000
errors a month at the time of writing), and a documented scrubbing hook in each SDK. One
project per runtime keeps their alerts apart.

Not chosen: a self-hosted GlitchTip (a new service to run, against CLAUDE.md's "no extra
services"), Vercel's log drains (Vercel only, so not the agent or Fly), and Better Stack
(logs, not errors with stack traces).

The maintainer creates the Sentry organisation and the four projects. No agent signs up.

### 2. Off unless configured

Nothing is sent unless the runtime's DSN variable is set:

| Runtime          | Variable                 | Where                                                  |
| ---------------- | ------------------------ | ------------------------------------------------------ |
| Website, server  | `SENTRY_DSN`             | Vercel `part-2-clients`                                |
| Website, browser | `NEXT_PUBLIC_SENTRY_DSN` | Vercel `part-2-clients` (build-time)                   |
| API              | `SENTRY_DSN`             | Vercel `stellar-platform`                              |
| Realtime         | `SENTRY_DSN`             | Fly `stellar-demo`                                     |
| Agent            | `SENTRY_DSN`             | the agent's environment (Fly for the simulated agents) |

`SENTRY_ENVIRONMENT` (`demo`, `production`, `development`) labels events; unset, the
deployment name is used. No source maps are uploaded, so no Sentry auth token exists in any
build.

### 3. What is never sent

Every SDK runs with its "send default PII" switch off, and every event passes one scrub
before it leaves the process:

- no user object, IP address, cookie, request body, query string or request header other
  than `user-agent`;
- any email address, `Bearer` value, JSON web token, and any value after a key named like
  `token`, `password`, `secret`, `key`, `code` or `signature` is replaced with
  `[scrubbed]` — in the message, exception values, breadcrumbs and extra data;
- no payment data: the platform's payment provider payloads are never attached, and any
  long hex or base64 run (a device token, a signed URL signature) is replaced.

Errors that are expected answers — a 4xx the API returns on purpose, a refused sign-in — are
not reported. Unhandled exceptions and `console.error` in the long-running processes are.

### 4. The browser reports through the website

The website's Content Security Policy allows `connect-src 'self'`. Rather than widen it, the
browser SDK sends to `/monitoring` on the site, and that route forwards the envelope only
to the project named by `NEXT_PUBLIC_SENTRY_DSN`. Anything else is refused. When the DSN is
unset the route answers 404 and the browser SDK is not started.

### 5. Proving it without an account

A forced failure in development, with the DSN pointed at a local listener
(`http://public@127.0.0.1:8999/1`), must arrive at that listener scrubbed. The evidence is
kept with the slice.

## Consequences

- When the maintainer creates the projects and sets the variables, errors from all four
  runtimes reach one place, and Sentry's own email alerts tell the maintainer.
- The free plan's quota is a ceiling: a loop that throws every second would exhaust it in
  under two hours. Sentry drops events over quota; it does not bill.
- Slice 6.10 reports real-user Web Vitals through the same browser SDK.
