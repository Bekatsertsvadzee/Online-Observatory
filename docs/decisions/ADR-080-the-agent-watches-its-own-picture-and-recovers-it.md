# ADR-080 — The Agent Watches Its Own Picture and Recovers It

- **Date:** 2026-11-01
- **Status:** PROPOSED
- **Decided by:** project maintainer (pending; direction given 2026-11-01 in the
  booked-session spec)
- **Amends:** ADR-004's description of VERIFYING (the disc centroid for Moon and planets)
- **Relates to:** ADR-001 (the agent owns the camera), ADR-011 (live view), ADR-021
  (colour frames), ADR-079 (a booked session runs for its whole slot), ADR-081 (unattended
  real operation), DV-035 (exposure measurements), `~/telescope/panel.py` (`stats`,
  `classify`, `run_autoexpose`, the `AE` table)

## Context

A session that lasts the whole slot (ADR-079) meets everything a 90-second one could
ignore: the mount drifts, the Moon moves half a degree an hour against the stars it is
tracked at, cloud crosses, an exposure set for one object is wrong for the next. Today the
agent plate-solves once, centres up to three times and never looks again; a blank or
off-centre picture stays that way until the session ends.

The maintainer's own panel already solves the picture problem on this telescope: it
classifies the scene from frame statistics, auto-exposes per scene, and re-solves every
few minutes. The ASTAP plate solve that VERIFYING uses cannot solve a frame of the Moon or
a planet, which is a disc with no field stars at these exposures.

## Decision

### 1. Auto exposure by object type and by the picture

The agent ports the panel's scene logic. The imaging profile names the starting scene
(LUNAR → moon, PLANETARY → planet, DOUBLE_STAR → star, GLOBULAR_CLUSTER → cluster,
PLANETARY_NEBULA and BRIGHT_NEBULA → deepsky), and the frame's statistics refine it
exactly as `classify` does. `run_autoexpose` walks exposure and gain to the scene's target
statistic, at most 14 tries. **The imaging profile's documented exposure range still
bounds every value** (contract `SetProfilePayload`): where the panel's table reaches
further (deep sky to 15 s), the profile wins. Phase 1 stays short-exposure.

Auto exposure runs after each acquisition, when the picture's statistic drifts outside
0.6–1.6 × its goal for two checks running (the panel's `ae_loop` rule), and as the first
rung of recovery.

### 2. Image health: five things a frame can be wrong about

On every live frame while OBSERVING, from the panel's `stats` (2× downsampled, normalised
to full scale: median, peak at the 99.97th percentile, background at the 25th, clipped
fraction, bright-blob fraction, star count):

| Reason        | Rule                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BLANK_FRAME` | peak − median < 0.02 and no stars: nothing above the background                                                                                                                                                           |
| `OVEREXPOSED` | clipped fraction > 0.25; for Moon/planet, a blown-out disc (clip > 0.02 and blob > 0.02)                                                                                                                                  |
| `NO_STARS`    | deep-sky or star profile, fewer than 3 stars, background not raised                                                                                                                                                       |
| `CLOUDS`      | stars < 30% of the count at acquisition **and** background ≥ 1.5× its acquisition value; for Moon/planet, the disc's peak < 40% of its acquisition value at the same exposure and gain; or a fitted sky sensor says cloud |
| `OFF_CENTRE`  | deep sky: solved centre more than max(2′, 10% of the short side of the field) from the target; Moon/planet: disc centroid more than 10% of the short side from the frame centre, or no disc in the frame                  |

A reason is reported only after it holds on three consecutive frames and at least ten
seconds, and cleared after two good frames, so one satellite or one gust does not start a
recovery. The verdict travels as `ImageHealth` on `AgentStateDelta`, and the cloud relays
it unchanged on `MissionTelemetryUpdate`. The client words it plainly ("Clouds over the
telescope — waiting for a gap", "Re-centring the object").

### 3. The recovery ladder, which never fights the mount

| Rung           | Applies to                                                      | What it does                                                                                                                  |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `RE_EXPOSE`    | BLANK_FRAME, NO_STARS, OVEREXPOSED                              | one auto-exposure run                                                                                                         |
| `RE_SOLVE`     | anything not cleared by RE_EXPOSE, and OFF_CENTRE               | a proper plate solve at the solve exposure (deep sky) or a disc centroid (Moon/planet) — never a blind slew                   |
| `RE_CENTRE`    | a solve that found an offset over the limit                     | a corrective slew of the solved offset, through the envelope like any slew, at most 3 iterations (`MAX_CENTERING_ITERATIONS`) |
| `WAIT_FOR_SKY` | CLOUDS, or a solve that failed twice with the background raised | hold on the target, tracking, live view running; status WAITING; retry from RE_EXPOSE every 120 s                             |

Two full passes without success, and no clouds to explain it, is **UNRECOVERED**: the
agent stops moving the mount for that object, keeps the live view, re-checks (re-expose
and solve, no slew unless the solve succeeds) every 300 s, and the dwell lock is waived so
the customer may switch (ADR-079 §4). RETARGET and RECENTER re-arm the ladder.

Never fighting the mount means: at most 6 corrective slews in any 10 minutes, none while
CAPTURING, a slew in progress is never interrupted by a new correction, and a mount fault
is a mount fault — the existing HARDWARE_ERROR path, Park — not a recovery.

After the mission first reaches OBSERVING, image problems never fail it. A retargeted
object that will not solve or centre returns to OBSERVING with health UNRECOVERED rather
than ending the session. The first acquisition keeps ADR-004's failure behaviour.

### 4. Staying centred

While OBSERVING and OK:

- **Deep sky:** a plate solve every 300 s; re-centre when the offset exceeds the
  OFF_CENTRE limit. The live stack is reset after a correction.
- **Moon and planets:** the disc centroid is measured on every live frame (it costs
  nothing), and a correction is made when it has been off-centre for three frames, at most
  once every 30 s. This is what keeps the Moon in the field through a four-hour slot.

None of this runs while CAPTURING.

### 5. VERIFYING for a disc is a centroid

For LUNAR and PLANETARY profiles, VERIFYING measures the bright disc's centroid and its
offset from the frame centre instead of calling ASTAP, and CENTERING corrects that offset.
The state names and their place in the machine do not change; only what VERIFYING
measures does. A frame with no disc is `OFF_CENTRE`, not a solve failure.

## Alternatives considered

**Plate-solve the Moon with a wide-field guide camera.** There is none, and adding one is
a hardware change this record does not need.

**Recover by spiral search.** Rejected: blind slewing is the mount-fighting the owner ruled
out, and a solve tells the agent where it is instead of guessing.

**Fail the session on a lost picture.** Rejected after first acquisition: it turns a
cloud or a drift into a lost slot, and the customer is better served by the live view and
the option to switch.

## Consequences

- Contract: `ImageHealthStatus`, `ImageHealthReason`, `RecoveryStep`, `ImageHealth`,
  `AgentStateDelta.imageHealth`, `MissionTelemetryUpdate.imageHealth`. Additive.
- Agent: a frame-statistics module, a scene classifier and auto exposure ported from
  `panel.py` (with tests against `SimCamera` frames, including injected blank, saturated,
  cloud-dimmed and shifted frames), a watchdog with the ladder, the periodic re-solve and
  the centroid path. The simulator must be able to produce each fault on demand.
- Every number in §2–§4 is provisional until DV-035 measures it on the real ASI585MC; the
  simulator defines none of them.
- A mission's health history is in its telemetry, not its events. If the refund engine
  needs "minutes lost to cloud", that is a separate decision (DV-111).

## When this would be revisited

When first light shows the thresholds wrong for this camera and sky, or when a sky sensor
is fitted and can replace the image-based cloud test (ADR-081).
