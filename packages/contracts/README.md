# @darkview/contracts

Generated TypeScript types and Zod validators for every payload that crosses a
process boundary.

**Nothing in `generated/` is written by hand.** The single source of truth is
`contracts/openapi.yaml` at the repository root.

```
npm run contracts:generate   # regenerate from the spec
npm run contracts:check      # fail if the committed output has drifted
```

`contracts:check` runs on every pull request. If it fails, run
`contracts:generate` and commit the result — do not edit `generated/`.

Need a field that does not exist? Stop. Do not add a local type or a private
endpoint. Open a contract issue against `contracts/openapi.yaml`.

Pydantic models for the Python Observatory Agent are generated from the same
spec into `agent/contracts/`. That half is not wired yet — see the note in
`docs/planning/phase1-issue-decomposition.md` (DV-003).
