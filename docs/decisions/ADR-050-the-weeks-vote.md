# ADR-050 — The week's vote

- **Date:** 2026-10-16
- **Status:** PROPOSED — built on the maintainer's instruction of 2026-10-16 to bring the
  Skychaser site's vote to Stellar; the client half is ADR-053 there, and it asked for
  this in `docs/platform-requests/weekly-vote.md`.
- **Decided by:** project maintainer
- **Relates to:** `ADR-015` (slots from astronomical darkness, at one observatory),
  DV-067 (visibility is a fact about a site), `ADR-044` (account deletion).

## Context

The client shows a weekly ballot: the targets the observatory can observe that week, and
a vote for which one it photographs first. Nothing in the contract recorded a customer's
choice, and the client may not invent a store, so the ballot stood with blank counts.

## Decision

1. **One vote per customer, per observatory, per week.** A `Vote` row keyed on the
   three, moved in place when the customer votes again. Every customer's vote counts
   once; the source product's holder weights are its wallet's and are not wanted.
2. **The week is its Monday in the observatory's local calendar**, and it locks on that
   week's Sunday at 13:00 UTC. After `locksAt` a vote is refused with `VOTE_LOCKED`. The
   operator reads the winner; nothing is scheduled automatically.
3. **The candidates are the observatory's sky.** A target is on the ballot when the
   visibility rules of `GET /targets/tonight` pass at any of three instants of any night
   of the week — half an hour into astronomical darkness, its middle, half an hour before
   dawn — with the observatory's current state left out: a weather hold tonight is not a
   fact about Saturday. Its safety envelope is a fact about the instrument and stands, so
   an unmeasured envelope leaves the ballot empty, as it leaves every slot empty. A vote
   for a target not on the ballot is refused with `TARGET_NOT_A_CANDIDATE`.
4. **`GET /votes` is public and `POST /votes` is not.** Reading the ballot needs no
   account; a session, when present, adds the caller's own vote as `mine`. Casting needs
   a session and the web client's origin, like every mutation (ADR-016 §3).
5. **Deletion takes the votes with it** (ADR-044): a deleted account leaves no vote.

## Consequences

- Contract: `GET /votes`, `POST /votes`, schemas `WeekVote`, `WeekVoteCandidate`,
  `CastVoteRequest`, error codes `VOTE_LOCKED` and `TARGET_NOT_A_CANDIDATE`; the `votes`
  tag.
- Database: table `Vote`, migration `20261016180000_adr050_weekly_vote`.
- No rate limit on casting: a vote is an idempotent upsert on the caller's own row, so a
  flood changes nothing but the row's `updatedAt`.
- The client syncs the contract and lets the ballot count (ADR-053 §8 there).
