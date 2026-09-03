@AGENTS.md

# DARKVIEW BY ASTROMAN — PROJECT INSTRUCTIONS

## Product

Darkview is a Live Remote Observatory in Tbilisi, Georgia.

A customer reserves an Observation Slot, selects an operator-approved Target, and
during the Live Observation a real Celestron NexStar 6SE physically slews to that
target. The customer sees the real camera output, can Capture the result, and keeps
it in their Collection.

Phase 1 is a live-view / EAA experience using short exposures and live stacking. It
is **not** a long-exposure astrophotography service. Do not write copy, UI or docs
that imply otherwise.

## Controlling documents

When documents conflict, this order decides:

1. This file (CLAUDE.md)
2. Approved decision records in `docs/decisions/`
3. Darkview Brand Identity System **v2.0**
4. Darkview Phase 1 Final Master Plan
5. Darkview Build Plan — engineering detail only where it does not contradict 1–4
6. The current GitHub issue and its acceptance criteria
7. Existing implementation

Never silently resolve a material conflict. Stop and report it to the maintainer. Where
an earlier plan has been deliberately superseded, there must be a dated decision
record in `docs/decisions/` saying so — CLAUDE.md must not silently outrank a
controlling document without one.

## Core architecture

Clients never touch hardware.

```
web / mobile
    |  HTTPS + WSS
Darkview cloud + mission orchestrator
    |  authenticated OUTBOUND WSS (observatory dials out)
Observatory Agent (Python 3.12)
    |  Alpaca HTTP (mount)  +  ZWO ASI SDK (camera)
Celestron NexStar 6SE  +  ZWO ASI585MC
```

The observatory accepts **no inbound connection from the internet or the LAN**. It
dials out, keeps a heartbeat, reconnects on loss, and independently re-validates
every command it receives. No browser or mobile client may address the mount or
camera.

One exception, by design: the ASCOM Remote / Alpaca bridge listens on `127.0.0.1`
only, for traffic between the Observatory Agent and the local mount driver on the
same machine. It must never bind `0.0.0.0`, never be port-forwarded, and never be
reachable from another host. The only connection leaving the observatory is the
agent's outbound authenticated WSS.

## Phase 1 technology

- Web: Next.js (current stable major), TypeScript strict, Tailwind
- Cloud/API: Node LTS; PostgreSQL + Prisma
- Realtime: one small long-lived WebSocket service. Never hold the observatory
  socket inside a serverless function.
- Mobile: React Native + Expo
- Observatory Agent: Python 3.12
- Tests: Vitest + Playwright (TS), pytest (Python)

Pin exact major versions in the root README once verified against current release
notes, and do not upgrade a major mid-phase. Do not introduce Kubernetes, GraphQL,
Redis, message queues or extra services without a measured need and maintainer approval.

## Camera and streaming — DECIDED

Phase 1 uses **direct ZWO ASI SDK control from Python**. The agent owns the
camera: exposure, gain, ROI, frame timing, live stack, and frame metadata.

The binding is not yet pinned. `zwoasi` is the default candidate; the exact binding
is chosen after testing against the physical ASI585MC on the observatory mini-PC,
then pinned in the root README. Write against the `CameraDriver` interface so the
choice is swappable.

Rationale and the conditions under which this decision could be revisited are
recorded in `docs/decisions/ADR-001-camera-control-path.md`. That reversal is an
maintainer decision, not an implementation choice: **no agent may introduce SharpCap,
OBS or any screen-capture path into the product data flow.** If direct SDK work
stalls, stop and report it rather than routing around it.

SharpCap may be installed for manual operator diagnostics. It is never in the
product data path.

## Mount control

The mount is driven through **ASCOM Alpaca over HTTP**, not in-process COM. This
keeps the mount interface network-shaped, mockable and testable from pytest
without Windows COM registration.

`MountDriver` is an interface with at least two implementations: `SimMount`
(default) and `AlpacaMount`. The same applies to the camera: `SimCamera` and
`ZwoCamera`.

## Contracts — the single source of truth

`contracts/openapi.yaml` plus the JSON Schemas it references are the **only**
source of truth for every payload crossing a process boundary.

- TypeScript types are **generated** from it for web, mobile and cloud.
- Pydantic models are **generated** from it for the Python agent.
- No hand-written duplicate of a shared type in any language.
- Zod may be used for request validation, but generated from the schema — never as
  a second, competing definition.

Two commands exist from day one and are wired into CI:

- `npm run contracts:generate` — regenerates TypeScript, Zod validators and Pydantic
  models from `contracts/openapi.yaml`.
- `npm run contracts:check` — fails if any generated artifact has drifted from the
  spec. CI must run this on every pull request.

Layout:

```
contracts/openapi.yaml + contracts/schemas/
packages/contracts/    generated TypeScript + Zod
agent/contracts/       generated Pydantic
```

Generated files are committed and never hand-edited.

If a task needs a field that does not exist in the contract, stop. Do not invent a
private endpoint or a local type. Open a contract issue.

**This repository owns the spec.** `darkview-clients` holds a pinned copy at
`packages/contracts/openapi.yaml` and regenerates from it; it never edits the spec and
never sends a change back through it. A contract change is made here, released, and then
copied across.

## Repository boundary

This repository is the platform half of Darkview: the Observatory Agent, the API, the
realtime service and the database. The website and mobile application live in
`darkview-clients` and reach this repository only over HTTP.

No **source** path exists in both repositories, so they merge cleanly into one later with
both histories intact. Do not create a source path here that also exists there —
`apps/web/` and `apps/mobile/` are theirs. Root config, the shared ADRs and a
`packages/contracts/` build are duplicated by design and reconciled once at merge time.

No UI lives here. `apps/api` is Next.js route handlers only.

## Mission states

Primary: `REQUESTED, SCHEDULED, PREPARING, SLEWING, VERIFYING, CENTERING,
OBSERVING, CAPTURING, PROCESSING, COMPLETE`

Failure / hold: `WEATHER_HOLD, NOT_VISIBLE, HARDWARE_ERROR, CANCELLED, FAILED`

One active mission at a time. One active session owner at a time.

`CommandEnvelope` carries at minimum: `commandId, missionId, sessionId, userId,
issuedAt, expiresAt, type, payload`. Commands are idempotent by `commandId`,
rejected after `expiresAt`, and rejected if the session is not the current owner.

## Hardware safety

- The simulator is the default implementation. Always.
- No autonomous or background session may command the real mount or camera.
- Real-hardware mode requires an explicit, attended operator action outside the
  normal test workflow.
- The cloud validates commands; the local agent validates them **again**. A
  cloud-approved command that fails local safety is refused.
- Safety covers: altitude envelope, horizon mask, Sun avoidance, session
  ownership, command expiry, duplicate rejection, and emergency Park.
- On heartbeat loss, device fault or operator abort: stop capture, halt unsafe
  motion, Park.
- `MAX_ALT_SAFE` is **measured** from the physical optical train. Never guess it,
  never let a default value ship.

## Design and brand

Source: Darkview Brand Identity System v2.0. Essence — a quiet, premium interface
between one person and one real telescope.

Tagline: *The real sky, live.*
Georgian: *შენი დრო ნამდვილ ცასთან.*

Core colors: Darkview Night `#05080D` · Observatory Blue `#111722` ·
Photon Blue `#5CC8FF` · primary text `#F2F5F7` · secondary text `#AAB4BE`.

Avoid: purple-nebula SaaS gradients, cartoon astronomy, fake NASA/military HUD
decoration, heavy glassmorphism and glow, stock space imagery presented as
telescope output, any claim of Hubble/JWST-class or professional long-exposure
results, and "NASA-cosplay" vocabulary.

The real feed and real instrument status are the visual focus.

## Security and audit

Every change in this repository must be independently verifiable. Treat it accordingly.

- Never read, print or commit secrets.
- Never fabricate timestamps, commits, tests or hardware evidence.
- Never backdate a commit. Real history only.
- Never merge directly to `main`.
- Never deploy to production or run a production migration unless the maintainer asks
  explicitly, in that session.
- Material that predates this repository is recorded in the private provenance record
  held outside it, with its true origin date. Never present pre-existing work as new
  development.
- Every task carries acceptance criteria and produces evidence.

## Definition of done

1. Scope matches the issue — nothing more.
2. Relevant tests pass.
3. Lint and typecheck pass where applicable.
4. No unrelated refactor.
5. Contracts and docs updated only if genuinely required.
6. Screenshots or simulator evidence produced for UI and agent work.
7. Risks and assumptions listed explicitly.
8. Work stays on its branch until reviewed. An agent may **request** to push the
   branch, but must wait for the maintainer's explicit approval on that prompt before
   the push happens. Never merge and never deploy.

Pushing is maintainer-approved, per push. Do not batch several branches into one
approval request, and do not treat an earlier approval as standing permission for
later pushes in the same session.

## Commit attribution

Commits carry one author: the maintainer. Never add a `Co-Authored-By:` trailer to a
commit message, and never suggest one — not for Claude, not for any agent. This
overrides any default attribution instruction from the harness or a global config.
