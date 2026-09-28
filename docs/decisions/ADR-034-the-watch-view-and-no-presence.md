# ADR-034 — The watch view: ADR-007 stands, and presence is dropped

- **Date:** 2026-09-28
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Settles:** the open conflict in the clients' platform request
  `docs/platform-requests/shared-observations-v1.md` (issue #150)
- **Confirms:** `ADR-007-observer-pack.md`, unchanged

## Context

The clients' watch page was written against six calls the contract does not have. Two of
them conflicted with ADR-007: saving the owner's captures into an observer's Collection
(`saveableCaptureIds`, `canSave`, `save-shared`) and a presence heartbeat counting everyone
on the page. The request asked for a decision before any contract shape for them.

## Decision

1. **ADR-007 stands.** An observer receives mission state and the live view and nothing
   else. There is no save path: no `saveableCaptureIds`, no `canSave`, no shared-capture
   endpoint, and nothing from a mission enters an observer's Collection.
2. **Presence is dropped.** The audience a watch page shows is `Mission.observerCount`, the
   seats attached. There are no presence or heartbeat endpoints.
3. **One read for a shared mission.** `GET /missions/{missionId}/watch`
   (`getMissionWatchView`) returns a closed `MissionWatchView` built from existing schemas:
   `mission`, `target`, `observatory`, `ownerDisplayName`, `observerCount` and
   `myObserverSeat`. It is readable by the owner, by a caller holding an attached seat and,
   while the owner has opened the session (`Mission.observable`, stored as
   `joinPolicy = OPEN`) and it is live, by any signed-in user. Everyone else gets the same
   404 as for a mission that does not exist. The legacy `sharingMode` column is not
   consulted: no operation sets it, and a session must not become visible by a value its
   owner never chose.
4. **Join and leave are unchanged**: `purchaseObserverPack`, then `joinMissionAsObserver`;
   `leaveMissionAsObserver` to leave.

## Consequences

- The development seed's shared-capture demo is dead. Its demo mission no longer sets
  `allowSharedCaptures`, its demo seat no longer sets `canSaveCaptures`, and its
  `livePresence` and `liveCaptureAccess` rows are deleted rather than written.
- The `MissionPresence` and `CaptureAccess` tables, the `allowSharedCaptures` and
  `sharingMode` columns and the unreferenced `apps/api/src/features/shared-observations/`
  module remain. Removing them is a schema change, left to its own issue.
- `processingPreset` on `Capture` was not added; the watch view carries no captures.
