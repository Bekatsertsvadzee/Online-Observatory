# Darkview Platform

**The observatory agent, the API, the realtime link and the database.** This is the
half of Darkview that talks to the telescope and owns the data.

Darkview is a Live Remote Observatory in Tbilisi, Georgia. A customer reserves an
Observation Slot, chooses an operator-approved Target, and during the Live Observation a
real Celestron NexStar 6SE physically slews to it. Phase 1 is a **live-view / EAA**
experience using short exposures and live stacking — not a long-exposure astrophotography
service.

The customer-facing website and mobile application live in a separate repository,
`darkview-clients`, and reach this one only over HTTP using the generated contract.

## Repository boundary

```
darkview-platform  (this repository)      darkview-clients
  agent/       Observatory Agent (Python)   apps/web/     Next.js site
  apps/api/    REST API, auth, payments     apps/mobile/  Expo application
  apps/realtime/  observatory WSS            packages/contracts/  generated, from a
  packages/db/    Prisma schema                                   pinned copy of the
  contracts/      openapi.yaml  <-- source of truth               spec below
```

`contracts/openapi.yaml` is the single source of truth for every payload crossing a
process boundary, in either repository. It is owned here. `darkview-clients` vendors a
pinned copy and regenerates from it; it never edits the spec.

**Merging the two later.** No source path exists in both repositories — `agent/`,
`apps/api/`, `apps/realtime/` and `packages/db/` are only here; `apps/web/` and
`apps/mobile/` are only there. What both carry is scaffolding: root config, the shared
ADRs, and a `packages/contracts/` build of the same spec.

So the merge is `git subtree add` twice, which lands each repository under its own prefix
with its history intact, followed by one reconciliation pass: hoist a single root
`package.json` workspace, keep this repository's `contracts/openapi.yaml` and delete the
pinned copy, keep one copy of each shared ADR. Client source needs no edit — it already
imports `@darkview/contracts` by package name.

Never create a source path here that also exists there.

## Pinned versions

Do not upgrade a major mid-phase.

| | Version | Notes |
| --- | --- | --- |
| Node | **24 LTS** (`v24.14.1` in use) | `engines: >=20.19` |
| npm | 11+ | workspaces |
| Next.js | **16.3.2** | API route handlers only — no UI in this repository. See `AGENTS.md` |
| TypeScript | **6.0.3** | strict |
| Prisma | **7.9.1** | `prisma-client` generator |
| PostgreSQL | **16+** | |
| Zod | **4.4.3** | generated from the contract, never hand-written |
| Vitest | 4.1.11 | |
| Python | **3.12.14** | Observatory Agent (`agent/.venv`) |
| ZWO ASI binding | **not yet pinned** | chosen after testing against the physical ASI585MC — ADR-001 |

## Layout

```
agent/               Observatory Agent (Python 3.12) + generated Pydantic
apps/api/            REST API, authentication, booking, payment, orchestration
apps/realtime/       observatory WebSocket service — /ws/agent, its own process
packages/db/         Prisma schema, migrations, seed, generated client
packages/contracts/  Generated TypeScript + Zod  (never hand-edited)
contracts/           openapi.yaml — the single source of truth
docs/                decisions, architecture, protocol, security
scripts/             contract generation and drift check
```

## Getting started

```bash
npm install
npm run db:generate
npm run contracts:check     # must be green before any work starts
npm run test
```

The Python agent has its own environment:

```bash
python3.12 -m venv agent/.venv
agent/.venv/bin/pip install -r agent/requirements-dev.txt
```

## Running the two processes

The API and the observatory link are separate processes and are not interchangeable. The
agent socket is long-lived; a serverless function cannot hold one, and `CLAUDE.md` forbids
trying.

```bash
npm run dev --workspace @darkview/api        # :4000  REST
npm run dev --workspace @darkview/realtime   # :4001  /ws/agent
```

The observatory dials out to the realtime service and presents its device token as
`Authorization: Bearer <token>`. Nothing dials the observatory: it has no reachable
address and no listening port. An observatory with no `deviceTokenHash` admits no agent.

The development seed issues a known token for the demo observatory, printed when the seed
runs. It is development-only — the seed refuses to run unless `NODE_ENV=development`.

## State of apps/api

`apps/api/src` holds the server-side modules extracted from the original
single-application prototype, plus the routes added since: `GET /health` and `GET /me`.
The booking, mission and admin routes do not exist yet — DV-052 onward add them.

## Where to start

| | |
| --- | --- |
| What we are building and why | `CLAUDE.md` |
| Decisions that bind | `docs/decisions/` |
| The work, with acceptance criteria | `docs/backlog.md` |
| System design and boundaries | `docs/architecture.md`, `docs/OWNERSHIP.md` |
| Observatory wire protocol | `docs/observatory-protocol.md` |
| Security model | `docs/security.md` |
