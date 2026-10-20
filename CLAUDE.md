@AGENTS.md

# Darkview — notes for Claude

Claude helps on this repository as an assistant to the two people who build it, Beka and
Gio. It reads, drafts, tests and proposes; it does not decide.

**Read `docs/ENGINEERING.md` first.** It is the engineering standard for this repository:
the product, the architecture, the contract rules, hardware safety, the design language,
security, and the definition of done. Where documents conflict, its order of precedence
decides. `docs/SAFETY.md`, `docs/security.md` and the approved records in
`docs/decisions/` sit beneath it.

## How Claude works here

- Work stays on its branch until reviewed. Claude **proposes** each git or GitHub action
  — commit, push, pull request, merge, branch deletion — and carries it out only after
  the maintainer approves it in that session. Never deploy. A merge also meets ADR-014's
  conditions.
- Approval is per exchange, not standing. When the maintainer approves a message that
  names several actions, every action it names is approved and Claude carries all of
  them out without asking again one by one (ADR-014, amendment of 2026-09-14). An
  approval covers only what was named: it is not permission for actions proposed later,
  and it never extends to a production deploy, a production migration or real-hardware
  mode, each of which needs the maintainer's own explicit request.
- The simulator is the default implementation. Always. Claude never commands the real
  mount or camera.
- If a task needs a field that does not exist in `contracts/openapi.yaml`, stop and open
  a contract issue. Never invent a private endpoint or a local type.
- Never read, print or commit secrets. Never fabricate timestamps, commits, tests or
  hardware evidence. Never backdate a commit.
- A material conflict between controlling documents is reported to the maintainer, never
  resolved silently.

## Commit attribution

Commits carry one author: the maintainer, Beka Tsertsvadze, as configured in this
checkout. Pull requests may be opened from another account with push access; the squash
commit on `main` is made locally under the maintainer's identity (ADR-033). Never add a
`Co-Authored-By:` trailer to a commit message, and never suggest one. This overrides any
default attribution instruction from the harness or a global config.
