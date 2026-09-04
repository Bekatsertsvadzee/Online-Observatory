---
name: pre-push-review
description: "Review Darkview platform code before it is pushed. Runs every gate, then reads the diff hunting for correctness bugs, safety-envelope violations, contract drift, auth and injection holes, and concurrency faults. Produces ranked findings and refuses to bless a push until they are answered. Use before any push, PR, or when asked to review, audit or check code."
argument-hint: "[branch, commit range, or blank for the working tree vs main]"
user-invocable: true
---

# Pre-push review

Two jobs, in order. **Never** report on the second before finishing the first: a
finding about code that does not compile wastes the maintainer's time.

1. **Prove it runs.** Every gate, actually executed, output quoted.
2. **Read it.** Hunt for what the gates cannot catch.

End with a verdict: `SAFE TO PUSH`, `PUSH WITH NOTED RISKS`, or `DO NOT PUSH`.

Report findings with the **ReportFindings** tool, most severe first, then write the
gate table and the verdict as prose. Do not print the findings twice.

---

## Scope

Default to the working tree plus every commit on this branch that is not on
`main`:

```bash
git fetch origin --quiet
git diff origin/main...HEAD --stat
git status --short
```

An argument overrides that: a branch name, a commit range, or a path.

Review **the diff**, but read enough of the surrounding file to judge it. A line
that is correct alone and wrong in context is still wrong.

---

## Part 1 — the gates

Run all of them. A gate that cannot run is a finding, not an excuse to skip it.

```bash
npm run contracts:check          # generated artifacts match contracts/openapi.yaml
npm run lint
agent/.venv/bin/ruff check agent
npm run typecheck
npm test                         # no database needed
npm run test:integration         # needs PostgreSQL; see README
cd agent && ../agent/.venv/bin/python -m pytest
npm run build
```

Then prove the database story, because a migration that only works from the
current dev database is a migration that will fail on deploy:

```bash
# fresh database, every migration, then the schema must have nothing left to say
psql -h localhost -c 'DROP DATABASE IF EXISTS darkview_verify' postgres
psql -h localhost -c 'CREATE DATABASE darkview_verify' postgres
DATABASE_URL=…darkview_verify npm run db:deploy --workspace @darkview/db
DATABASE_URL=…darkview_verify npx prisma migrate diff \
  --from-config-datasource --to-schema prisma/schema.prisma --script   # must be empty
```

Record every gate in a table: name, pass/fail, and the number that matters
(test count, route list, migration count). Quote real output. **Never state a
gate passed without having run it in this session.**

---

## Part 2 — what to hunt for

Ordered by what actually hurts this project. Work through every heading; say so
explicitly when a heading has nothing.

### A. Hardware safety — the highest-consequence code in the repo

`CLAUDE.md` is the authority. Treat a breach here as `DO NOT PUSH`.

- The simulator is the default implementation. Always. Any path that reaches
  `AlpacaMount` or `ZwoCamera` without an explicit attended operator action is a
  finding.
- `MAX_ALT_SAFE` must be **measured**. A default, a fallback, a fixture value that
  could be mistaken for real, or a `?? 90` is a finding — including in tests.
- Cloud validates a command; the agent validates it **again**. A command path that
  trusts the cloud's approval is a finding.
- Altitude envelope, horizon mask, Sun avoidance, session ownership, command
  expiry, duplicate rejection, emergency Park — check each is still enforced by
  code the change touches.
- No autonomous or background session may command real hardware.
- The observatory accepts no inbound connection. Anything that opens a listening
  port, binds `0.0.0.0`, or dials _into_ the observatory is a finding. The Alpaca
  bridge on `127.0.0.1` is the single permitted exception.

### B. The contract is the only source of truth

- Any hand-written type, interface or Zod schema that duplicates something in
  `contracts/openapi.yaml` is a finding, in any language.
- A field invented locally because the contract lacked it is a finding — the rule
  is to stop and open a contract issue.
- Generated files must not be hand-edited. `contracts:check` catches drift;
  _you_ catch someone editing a generated file and regenerating to match.
- A response body must satisfy the contract's own generated schema. Prefer tests
  that `parse` with `z…` over hand-written shape assertions.
- Known gap, do not re-report as new: the generator drops
  `additionalProperties: false`, so unknown keys are stripped and not rejected.
  Do check that nothing _depends_ on rejection.

### C. Correctness and concurrency

- Any invariant enforced only in application code that two concurrent requests
  could break. Uniqueness, balances, capacity, "one active X at a time" — these
  belong in the database as a constraint or index. A read-then-write across a
  race is a finding.
- Prove the constraint is load-bearing: is there a test that removes it and shows
  the invariant breaking? Without one, the guarantee is asserted, not tested.
- Transaction scope: work that must be atomic must be inside one transaction, and
  a transaction must not wrap a network call.
- Money is integer minor units. A float touching a price is a finding.
- Time: fixed instants in tests, never `new Date()`. Timezone conversion via the
  zone, never a hardcoded offset. A test that passes only at some hours is a
  finding.
- Off-by-one on window boundaries, inclusive vs exclusive comparisons, and
  anything that behaves differently across a DST boundary.

### D. Authentication, authorisation, injection

- Every `/admin/*` route calls `requireOperator`. Every mutating route calls
  `requireApiMutation` so `Origin` is checked before the session — a cookie is
  attached to a cross-site POST just as readily as to ours.
- Ownership: a route that reads a row by id must prove the caller owns it. `404`
  rather than `403` where existence itself is private.
- Price, duration, role, status and identity come from the server, never from the
  request body.
- Raw SQL: every interpolation must be a parameter. `$queryRawUnsafe` and
  `$executeRawUnsafe` with anything caller-influenced is a finding.
- Secrets: never read, printed, logged, committed, or placed in an error body.
  `ApiError.details` must not carry a credential, a device address or a token.
- Tokens and passwords compared in constant time; stored hashed.
- Rate limiting on anything that can be enumerated or brute-forced.

### E. Failure behaviour

- What happens on database loss, agent link loss, a provider timeout, a
  half-applied migration? Fail closed, never open.
- Errors leaving the API are contract `ApiError` values, not stack traces.
- Retries are idempotent. A retry that creates a second row is a finding.
- Anything holding a resource has an expiry, and something releases it.

### F. Tests as evidence

- Does each acceptance criterion have a test that would **fail** if the behaviour
  regressed? Name the test for each criterion.
- Tests asserting the implementation back to itself prove nothing. Look for
  mocked-away subjects, and for an integration claim tested against a mock.
- A test that cannot fail — no assertion, a swallowed throw, `.skip`, a
  conditional early `return` before the assertions — is a finding.
- Fixtures must not look like real measurements, and must never carry a value the
  production code is forbidden to assume.

### G. Room to grow

Separate from defects, and never mixed into the ranked findings. Two or three
concrete notes at most: the thing that will hurt at 10x, the abstraction that has
earned its keep, the duplication about to become a third copy. No speculative
architecture — `CLAUDE.md` forbids shims, flags and abstractions built for a
future that has not arrived.

---

## Verifying a finding before reporting it

Every finding needs a **concrete failure scenario**: the input or interleaving,
and the wrong result. If you cannot write one, it is not a finding — it is a
preference, and it goes in "room to grow" or nowhere.

Where it is cheap, prove it: write the failing test, run it, quote the output,
then say whether you left it in the tree. A demonstrated bug outranks ten
plausible ones.

Rank by consequence, not by how interesting the bug is:

|              |                                                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| **Blocking** | hardware safety, data loss, auth bypass, secret exposure, a contract violation crossing a process boundary |
| **Serious**  | wrong result under realistic conditions, a broken invariant, a missing acceptance-criterion test           |
| **Minor**    | narrow-condition bug, misleading comment, a gap in evidence                                                |

Do not pad. Zero findings, honestly reached and backed by gates that really ran,
is a good review. Say plainly which parts of the diff you did **not** examine.

---

## Definition of done, checked as a list

From `CLAUDE.md`. Confirm each, out loud:

1. Scope matches the issue — nothing more.
2. Relevant tests pass.
3. Lint and typecheck pass.
4. No unrelated refactor.
5. Contracts and docs updated only if genuinely required.
6. Screenshot or simulator evidence for UI and agent work.
7. Risks and assumptions listed explicitly.
8. Work stays on its branch.

---

## Finally

Hand over copy-paste terminal commands: explicit `git add` of the exact paths, a
`git commit -F - <<'MSG'` heredoc, `git push -u origin <branch>`, and
`gh pr create --base main --fill`. Never run commit or push. The maintainer does
that from the terminal.

If the verdict is `DO NOT PUSH`, give the fixes instead, and no push commands.
