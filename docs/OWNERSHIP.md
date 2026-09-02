# Ownership — who owns which files

Two agents never own the same file. A merge conflict between tracks means a boundary was
crossed: fix the boundary, not just the conflict.

## Boundaries inside this repository

| Agent | Owns | Never touches |
| --- | --- | --- |
| **darkview-observatory** | `agent/**` (except `agent/contracts/`, which is generated) | api, realtime, contract spec |
| **darkview-cloud** | `apps/api/**`, `apps/realtime/**`, `packages/db/**` | agent internals, contract spec |
| **darkview-lead** | `contracts/**`, `docs/**`, root config, `.github/**`, `scripts/**` | implementation in any track |

## The other repository

`darkview-clients` holds the website and mobile application. Nobody here edits it, and
nobody there edits this one. The only thing that crosses is the contract, and it crosses
one way: released here, copied there.

A change that needs both repositories is two branches, two reviews, and the platform side
merges first.

## Rules

1. **The contract spec is lead-owned.** No worker agent edits `contracts/openapi.yaml`. A
   task needing a new field stops and opens a contract issue.
2. **Generated files are nobody's.** `packages/contracts/generated/`,
   `agent/contracts/models.py` and `packages/db/generated/` are produced by
   `npm run contracts:generate` and `npm run db:generate`. Never hand-edited, by anyone.
3. **One agent, one branch, one issue.** Branch naming: `obs/dv-020-agent-skeleton`,
   `cloud/dv-050-db-schema`, `lead/…`.
4. **Shared files need a lead decision.** Root config is lead-owned; a worker needing a
   dependency asks rather than edits.
5. **Two agents at once is the ceiling** for one reviewer. When in doubt, unblock the
   observatory track first — the critical path runs through it.

## Review and merge

darkview-lead reviews every branch and decides merge order. Nothing merges to `main`
directly, and nothing is pushed without explicit approval on that push.

## Definition of done

1. Scope matches the issue — nothing more.
2. Relevant tests pass; lint and typecheck pass.
3. No unrelated refactor.
4. `npm run contracts:check` is green.
5. The issue's stated evidence exists — screenshots, simulator logs, test output.
6. Risks and assumptions listed explicitly.
