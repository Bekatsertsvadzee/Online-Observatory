# ADR-076 — The Mount Over the Hand Controller's Serial Port

- **Date:** 2026-11-01
- **Status:** PROPOSED
- **Decided by:** project maintainer (pending)
- **Relates to:** ADR-001 (camera control path), ADR-024 (unattended posture), ADR-074 (the
  hardware test observatory), `docs/ENGINEERING.md` "Mount control", DV-028, DV-031, DV-034

## Context

The agent reaches the mount and focuser through ASCOM Alpaca (`AlpacaMount`,
`AlpacaFocuser`), which needs Windows, the ASCOM Platform, a Celestron ASCOM driver and
ASCOM Remote. The machine available to run the hardware test observatory is a dedicated
MacBook. macOS has none of that, and the NexStar 8SE's hand controller speaks only
Celestron's NexStar serial protocol, over a PL2303 USB-serial cable.

The maintainer's own panel (`~/telescope`) already drives this mount from the Mac: axis
positions with `z`, each axis's rate with the `P,3` passthrough, its own pointing model
fitted to sync points, its own GoTo and tracking loop with a runaway guard, and the
Celestron focus motor at AUX device 0x12.

## Decision

1. **A second REAL mount path, chosen by configuration.**
   `DARKVIEW_AGENT_MOUNT_DRIVER=NEXSTAR_SERIAL` builds `NexStarMount` and `NexStarFocuser`
   on one serial port, `DARKVIEW_AGENT_NEXSTAR_PORT`. `ALPACA` stays the default. Selecting
   REAL still needs `DRIVER_MODE=REAL` and `ATTENDED=1` from the process environment; this
   setting does not change that and the simulator ignores it.
2. **The same interfaces.** Both drivers implement `MountDriver` and `FocuserDriver` and
   pass the shared conformance suite. No safety rule moves into them: the envelope, the Sun
   check, MAX_ALT_SAFE, the watchdog and attended mode all sit above the driver as before.
3. **The panel's pointing model, read from its file.** The hand controller is not aligned;
   the driver maps sky to axes with the panel's model (sign and offset per axis, fitted to
   sync points) read from `DARKVIEW_AGENT_NEXSTAR_MODEL_PATH`, in the panel's
   `observatory.json` shape. The agent writes no sync points of its own; with none, the
   mount refuses to connect.
4. **GoTo and tracking by the driver's own loop**, four times a second, as the panel does.
   The driver adds the guards the hand controller lacks: a runaway stop, a fault when the
   loop stops while the mount moves, a halt on every exit, and no tracking below the
   horizon. Tracking needs the site coordinates, so the driver refuses to build without
   them.
5. **Nothing listens.** A serial port is a device file. `docs/ENGINEERING.md`'s single
   loopback listener is not used on this path at all.
6. **Live-view exposure is not auto-tuned.** The panel picks exposure from the picture; the
   agent takes exposure and gain from the mission request (the contract), and the live view
   reuses them. Changing that is a contract question, not part of this record.

## Consequences

- The hardware test observatory can run on the Mac with the camera through the ZWO SDK
  (`libASICamera2.dylib`) and ASTAP for macOS, without a Windows mini-PC.
- Pointing depends on a model the operator keeps current in the panel. Moving the tripod
  or power-cycling the mount invalidates it; the operator re-syncs before an attended run.
- The control figures (gain, arrival thresholds, the 4 deg/s ceiling, park position) and
  the focuser's limit and move-done commands (0x2C, 0x13) are written from the panel and the
  protocol, not measured. DV-034 measures them; nothing here is hardware evidence.
- `check-devices` still checks the Alpaca path only; a serial bring-up check is follow-up
  work.
- `docs/ENGINEERING.md` "Mount control" names Alpaca as the mount path. If this record is
  approved, that section gains this second implementation.
