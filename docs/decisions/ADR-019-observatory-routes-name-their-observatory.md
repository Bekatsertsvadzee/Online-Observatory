# ADR-019 — Every observatory route names its observatory in the path

- **Date:** 2026-09-15
- **Status:** PROPOSED
- **Decided by:** project maintainer, in session (direction: a path parameter, applied to
  the whole group at once)
- **Approved:** direction on 2026-09-15; this record awaits the maintainer's review
- **Arises from:** issue #76
- **Relates to:** `ADR-013` (partner observatories), `ADR-015` (booking per telescope),
  `ADR-017` (operator telemetry source)

## Context

ADR-015 made booking per telescope: `GET /slots` and `POST /bookings` take an
`observatoryId`, and `GET /observatories` lists every bookable one. The observatory's
own routes did not follow. `GET /observatory/state` and every `/admin/observatory/*`
route named no observatory, and the handlers resolved one with `currentObservatoryId()`
-- the earliest row, which is the first-party site.

A partner observatory (ADR-013) has a mode, a safety envelope, a weather state and a
link of its own. None of them could be read or set through the contract, and the public
status chip could not say which telescope it described. With more than one observatory,
"the earliest row" is a coin toss over which telescope an operator just switched to real
hardware.

## Decision

1. **The id is a path parameter, on all six operations together.**

   | Before | After |
   | --- | --- |
   | `GET /observatory/state` | `GET /observatories/{observatoryId}/state` |
   | `GET /admin/observatory/state` | `GET /admin/observatories/{observatoryId}/state` |
   | `POST /admin/observatory/mode` | `POST /admin/observatories/{observatoryId}/mode` |
   | `GET`/`PUT /admin/observatory/safety-envelope` | `GET`/`PUT /admin/observatories/{observatoryId}/safety-envelope` |
   | `POST /admin/observatory/weather-hold` | `POST /admin/observatories/{observatoryId}/weather-hold` |

   The old paths are removed, not aliased. Nothing outside this repository and
   `darkview-clients` calls them, and an alias would be a second path to keep in
   agreement with the first.

2. **The public route answers only for a bookable observatory.** It uses the rule
   `GET /observatories` uses. An id that does not exist and one whose node is not
   bookable get the same 404, so a customer cannot learn by probing ids that a
   suspended partner node exists.

3. **The admin routes answer for any observatory that exists.** An operator reviewing,
   suspending or holding a partner node has to reach it whatever its approval state.
   An unknown id is 404.

4. **`currentObservatoryId()` is deleted.** No request path resolves an observatory by
   picking a row.

## Alternatives considered

**A required query parameter** (`/observatory/state?observatoryId=`). It would have kept
today's paths and matched how ADR-015 scoped `GET /slots` and `GET /targets/tonight`.
Declined: those two filter a collection, and these routes address one observatory's own
state. Every other single resource in the contract carries its id in the path
(`/missions/{missionId}`, `/admin/network/nodes/{nodeId}`).

## Consequences

- The contract changes paths, not payloads. The generated TypeScript and Zod change, and
  the Pydantic models do not.
- `darkview-clients` must copy the released spec and move its calls to the new paths.
  Until it does, its status chip and operator console call routes that no longer exist.
- The internal telemetry route (`/internal/observatories/{observatoryId}/state`) was
  already shaped this way. The public and admin routes now match it.
