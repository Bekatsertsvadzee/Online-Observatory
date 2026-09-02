# ADR-001 — Phase 1 Camera Control Path

- **Date:** 2026-08-30
- **Status:** APPROVED
- **Supersedes:** the camera/streaming section of the Phase 1 Final Master Plan
- **Decided by:** project maintainer

## Context

The Phase 1 Final Master Plan specified that SharpCap would own the ASI585MC and
that Darkview would receive video by capturing SharpCap's viewport through
OBS/FFmpeg, with direct ZWO ASI SDK control deferred to Phase 2.

The subsequent Darkview Build Plan reversed this and specified direct SDK control
with SharpCap/OBS retained only as a schedule fallback. The two documents
therefore disagreed. This record resolves the conflict and states which one
governs the implementation.

## Decision

The Darkview Observatory Agent controls the ZWO ASI585MC **directly through the
ZWO ASI SDK** from Python. The agent owns exposure, gain, ROI, frame timing, live
stacking, frame metadata and capture output.

SharpCap and OBS are not part of the product data path. SharpCap may be installed
on the observatory mini-PC as a manual diagnostic tool for the operator.

## Reasons

- Direct access to raw frames rather than re-encoded screen pixels.
- Exposure, gain, timestamp and sensor metadata per frame, which screen capture
  cannot supply and which capture records and FITS output require.
- Plate solving needs real frame data, not a rendered viewport.
- Headless, automated testing. A screen-capture path cannot be tested in CI.
- Fewer runtime processes on the mini-PC. The in-stock fallback machine is an
  N95 with 8 GB RAM; removing SharpCap and OBS from the runtime is a material
  part of why that specification is workable.
- Smaller failure surface. Screen capture fails silently and in ways that look
  like a working stream.

## Schedule safeguard

Direct camera integration is timeboxed to **four engineering days** from the date
the ASI585MC is physically available and connected.

If stable frame acquisition has not been achieved by the end of that timebox, the
maintainer — and only the maintainer — may authorise a temporary SharpCap + OBS/FFmpeg
bridge so that the end-to-end MVP is not delayed.

Invoking the fallback requires:

1. A written note in this file recording the date, what failed, and what was
   tried.
2. A follow-up issue to return to direct SDK control.
3. `Status:` above changed to `APPROVED — FALLBACK ACTIVE`.

Development agents may not invoke the fallback, propose it as a workaround, or
implement any screen-capture path on their own initiative. If direct integration
stalls, the agent stops and reports.

## Consequences

- `CameraDriver` is an interface. `SimCamera` is the development default;
  `ZwoCamera` is the production implementation.
- The Python binding for the SDK is not pinned in advance. `zwoasi` is the
  default candidate and is confirmed against the physical camera on the
  observatory mini-PC before being fixed in the root README.
- The mount path is unaffected by this decision and is covered separately: CPWI /
  Celestron ASCOM driver, exposed through ASCOM Remote Server on `127.0.0.1` as
  an Alpaca HTTP device, consumed by the agent over localhost.
