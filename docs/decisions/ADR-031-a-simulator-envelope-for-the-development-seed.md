# ADR-031 — A simulator envelope for the development seed

- **Date:** 2026-09-28
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Approved:** 2026-09-28
- **Issues:** #147 (simulator safety envelope), #146 (night-side demo observatory), #145
  (demo passwords)
- **Amends:** the development seed's rule that it "must never set" `maxAltitudeDegrees`
  (`packages/db/prisma/seed.ts`, from DV-020/DV-034), and `docs/SAFETY.md` §2
- **Relates to:** `ADR-013` (partner observatories), `ADR-024` (unattended posture)
- **Numbering:** 031, not 025. `darkview-clients` already holds ADR-025 to ADR-030, and the
  decision records are reconciled into one directory when the repositories merge.

## Context

MAX_ALT_SAFE is measured from the physical optical train, never guessed, never defaulted
(CLAUDE.md, `docs/SAFETY.md` §2). The development seed therefore left the demo
observatory's `maxAltitudeDegrees` null, and while it is null the cloud and the agent both
refuse every slew with `SAFETY_ENVELOPE_UNMEASURED`.

That is correct for any observatory with a mount. It also meant that no simulated mission
could leave `SCHEDULED` on a freshly seeded stack, so nothing after mission start — the
live room, capture, the Collection entry, the operator's view of a running mission — could
be built or tested against the real platform before hardware arrives. The only other way
to set the value, `PUT /admin/observatories/{id}/safety-envelope`, would record a number
nobody measured under somebody's name: a fabricated measurement.

## Decision

1. **The seed writes a clearly-named fake, to simulated demo observatories only.** Each
   SIMULATED, `isDemo` demo observatory gets `maxAltitudeDegrees =
   SIMULATOR_MAX_ALTITUDE_DEGREES` (78, `packages/db/prisma/development-seed.ts`), with
   `maxAltitudeMeasuredBy = SIMULATOR_ENVELOPE_MEASURER` (`"SIMULATOR — NOT A
   MEASUREMENT"`, `packages/db/simulator-envelope.ts`) and a note saying it is not a
   measurement. The seed re-reads the row first and throws if it is not SIMULATED and
   `isDemo`.

2. **The marker is refused or ignored everywhere else, by the cloud.** An envelope whose
   `maxAltitudeMeasuredBy` begins with "SIMULATOR" (case-insensitive) is the simulator's:
   - the API's `loadSafetyEnvelope` and the realtime service's relay loader return it with
     `maxAltitudeDegrees: null` for any observatory not in `SIMULATED` mode, so pointing,
     mission start, the operator override and the agent relay all see UNMEASURED;
   - `setSafetyEnvelope` refuses to record it on an observatory not in `SIMULATED` mode;
   - `setObservatoryMode` refuses the switch to `REAL` while it stands;
   - `approveNetworkNode` never counts it as a measured envelope, in any mode.

3. **The agent refuses it independently.** `SafetyEnvelope` admits a marked envelope only
   when it is built with `simulated=True`, and the supervisor passes that only when both
   the configured driver mode and the wired mount report `SIMULATED`. Everywhere else the
   agent reads it as UNMEASURED and refuses every slew, including an envelope recovered
   from local state after a restart. The measurer already travels in
   `SafetyEnvelopeConfig`, so no contract change was needed. A pytest holds the agent's
   marker string equal to the TypeScript one.

4. **Daylight is solved with a second site, not an exemption (#146).** The seed adds a
   night-side SIMULATED demo observatory on Mauna Kea with its own ids, device token,
   APPROVED first-party node and whole-night availability. Every safety rule runs as
   written there; it is simply night.

## Consequences

- A freshly seeded stack runs a simulated mission end to end, in Tbilisi's night or, via
  the night-side observatory, its working day.
- The number 78 exists in the seed. It is not MAX_ALT_SAFE for any telescope, and DV-034
  still has to measure the real one. The first-party observatory's real envelope is
  written by an operator through `setSafetyEnvelope`, with a real measurer.
- An observatory that once carried the simulator envelope cannot become REAL until an
  operator records a real measurement or clears the value.
- `NetworkNode.safetyEnvelopeMeasured` is unchanged and reports `true` for a seeded
  simulator node; the node review shows the marker as `measuredBy`.

## When this would be revisited

If a simulated observatory ever shares a row with real hardware in a way `Observatory.mode`
does not capture, or if a real driver can report `SIMULATED`, this decision no longer
holds and the seed must stop writing the value.
