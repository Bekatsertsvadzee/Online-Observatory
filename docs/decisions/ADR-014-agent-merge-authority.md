# ADR-014 — An agent may merge a reviewed pull request, once, on the maintainer's word

- **Date:** 2026-09-10
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Approved:** 2026-09-10
- **Relates to:** `CLAUDE.md` § Security and audit, `CLAUDE.md` § Definition of done
- **Supersedes:** the unqualified "Never merge" rule in both of those sections

## Context

`CLAUDE.md` has said since the repository was created that an agent must never
merge. The rule was written when the risk was an agent shipping unreviewed work
to `main` on its own initiative, and against that risk it is the correct rule.

Two things have changed.

**A per-action approval loop now exists.** The maintainer's standing instruction
is that an agent proposes each git action, waits for an explicit accept or
decline, and only then performs it. Under that loop a merge is not an agent
deciding to ship; it is the maintainer deciding to ship and the agent typing it.

**Merging on github.com has produced wrong authorship three times.** A merge
commit made through the web interface is authored by whichever GitHub account
clicked the button. On 2026-09-10 that was the `Rezimod` account — display name
"Rezis Github" — and commits `cde66c4`, `d4768e8` and `232b096` on `main` carry
it. They cannot be corrected: rewriting `main` is forbidden, and a merged
commit's author is fixed. The same day, a fourth defect entered `main` because a
merge was performed against a stale page: `#57` was merged at the commit it had
loaded, silently omitting a pushed CI fix, and `main` went red.

A merge performed locally by the agent carries the repository's configured git
identity — the maintainer — and is made against the working tree as it actually
stands.

## Decision

**An agent may merge a pull request into `main`, and only under all five of the
following.** Any one of them absent means the merge does not happen.

1. **The maintainer has approved that specific merge, by name, in that session.**
   Not a standing permission, not an earlier approval, not an approval of the
   branch or the push. One approval, one merge — the same rule `CLAUDE.md`
   already applies to pushing.
2. **Continuous integration is green on the merge commit's parent.** The agent
   checks and states the run it read. A pending or failed run is a refusal, not
   a thing to wait out and merge anyway.
3. **The merge is a squash**, so one change is one commit and the message is
   written rather than generated.
4. **No agent appears in the authorship.** The `.githooks/commit-msg` hook
   refuses a `Co-Authored-By` trailer, and it applies to a squash message like
   any other.
5. **`main` only.** No other branch, no tag, no release, and nothing that
   deploys.

**Deployment is untouched and stays forbidden.** `CLAUDE.md` § Security and audit
continues to read that an agent never deploys to production and never runs a
production migration unless the maintainer asks explicitly in that session. This
record grants merge authority and nothing adjacent to it.

**The branch stays reviewable.** Nothing here weakens the requirement that work
sits on a branch with acceptance criteria and evidence until it has been
reviewed. What changes is who performs the final click, not whether a review
happened.

## Why this route

The alternative that keeps the old rule intact is for the maintainer to keep
merging on github.com and simply be more careful — sign in as the right account,
refresh the page first. That is what produced three wrong authors and one red
`main` in a single afternoon. A rule whose correct operation depends on a person
remembering four things at the moment they are least likely to be paying
attention is not a control; it is a hope.

Moving the click into the approval loop puts every one of those four things under
a check that runs every time: the identity is the repository's git config, the
staleness is impossible because the merge is made from a fetched ref, the squash
is a flag, and the trailer is refused by a hook.

## Alternatives considered

**Leave it forbidden and fix authorship on GitHub.** Renaming the `Rezimod`
account fixes the name and nothing else — the stale-page failure and the
merge-commit-versus-squash choice both remain manual. Worth doing anyway, and it
is not a substitute.

**Let the agent merge without per-merge approval.** Refused. The value of this
loop is that a person decides to ship each time. An agent that could merge on its
own judgement is the risk the original rule was written against, and nothing
about the last two days suggests that rule was wrong.

**Allow merge to any branch.** Refused as scope nobody asked for. `main` is the
branch where the authorship problem occurs.

## Consequences

- `.claude/settings.json` moves `gh pr merge` out of `deny`. It becomes an
  `ask`, so the permission prompt is a second gate underneath the approval this
  record requires.
- An agent that merges must report the run id it read for condition 2, so the
  claim is checkable after the fact rather than taken on trust.
- The three merge commits already carrying `Rezimod`, and the `Co-Authored-By`
  trailer on `fcbc115`, stay as they are. This record changes what happens next;
  it does not launder what happened.

## When this would be revisited

If an agent merges something the maintainer had not approved, or merges over a
failed or unread CI run, this record is withdrawn and the unqualified rule comes
back. One incident is enough — the control being described here is a person's
judgement, and an agent that routes around it has removed the only thing that
made the change safe.

## The amendment this record makes

`CLAUDE.md` § Security and audit: "Never merge directly to `main`." becomes a
statement that an agent merges only under this record's five conditions.

`CLAUDE.md` § Definition of done, item 8: "Never merge and never deploy." becomes
"Never deploy", with merging governed by this record.
