# contracts/schemas/

This directory exists for JSON Schema files referenced by `contracts/openapi.yaml`.

**It is currently empty on purpose.** Every Phase 1 cross-boundary type is defined inline
in `contracts/openapi.yaml` under `components/schemas`. One file is simpler to review, to
diff and to feed to both the TypeScript/Zod and the Pydantic generators.

## Rules

- Do not add a file here to work around a contract review. If a type crosses a process
  boundary it belongs in `contracts/openapi.yaml`, and only the technical lead approves
  the change.
- Split a schema out into this directory only when it is genuinely shared by more than
  one spec document, and only in an issue that says so. Splitting adds an external-`$ref`
  bundling step to `contracts:generate`, so it is a cost, not a neutral tidy-up.
- Nothing here is hand-edited downstream. Generated artifacts live in
  `packages/contracts/` (TypeScript + Zod) and `agent/contracts/` (Pydantic), are
  committed, and are verified by `npm run contracts:check` in CI.
