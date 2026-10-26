# ADR-074 — A Hardware Test Observatory Beside the Demo

- **Date:** 2026-10-26
- **Status:** APPROVED (maintainer's request of 2026-10-26, with the hardware on site and
  being assembled: "create separate now real observatory ... make all things set up and
  ready")
- **Decided by:** project maintainer
- **Relates to:** ADR-035 (the hosted demo), ADR-032 (the simulator's envelope), ADR-019
  (operators reach any observatory), ADR-015 (what is bookable), RUNBOOK §3 and §5,
  backlog Stage 2 (DV-034 onward)

## Context

The telescope, camera and focuser have arrived. The hosted deployment is a demo
(`DARKVIEW_DEPLOYMENT=demo`, ADR-035): it takes no real money and commands no hardware,
and both services refuse to start while any observatory is in REAL mode. Ending the demo
to bring the telescope up would also end the sandbox payments before Bank of Georgia's keys
are set (ADR-073), and would put the demo's simulated observatory, which customers book,
next to hardware nobody has measured yet.

Four further things stood between the hosted platform and a real agent:

- the Fly front passed only `/ws/mission/*` and `/stream/mission/*` to realtime, so an
  agent outside the machine could not reach `/ws/agent`;
- the simulated agent owns the demo observatory's link, and one observatory takes one
  agent;
- the operator console found its observatory in the public, bookable list, so it could
  not reach one that is not for sale;
- there was no observatory for the real telescope to be.

## Decision

1. **One named exception to ADR-035.** `DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID`, set on the
   API and on realtime, names the one observatory a demo deployment may switch to REAL.
   Everything else ADR-035 says stands: every other observatory is refused REAL with 403,
   and both services still refuse to start with any other observatory in REAL mode.
2. **It is never for sale.** It has no network node, so no customer can book it (ADR-015).
   If it ever has an APPROVED node, the API refuses to switch it to REAL on a demo.
3. **Every other REAL rule is unchanged.** An attended operator states they are present,
   the agent runs with `DRIVER_MODE=REAL` and `ATTENDED=1` from the real environment, and
   MAX_ALT_SAFE is measured (RUNBOOK §5) before anything slews. The observatory is created
   with the altitude limit null, which refuses every slew.
4. **The agent's link reaches realtime through the front.** `/ws/agent` joins the paths the
   Fly front proxies to realtime. The link authenticates with the device token before
   anything else is accepted, as it always has.
5. **Operators list every observatory.** `GET /admin/observatories` returns all of them,
   bookable or not, with `hardwareTest` marking this one; the operator console picks from
   it.
6. **The row is created by a script, not the seed.**
   `packages/db/prisma/hardware-test-observatory.ts` creates `stellar-tbilisi-hardware`
   (NexStar 8SE, 203/2032 mm; ZWO ASI585MC; the Phase 1 catalogue as compatible targets)
   and writes a new device token to a file of the operator's choosing, storing only its
   hash. Run again, it updates the site coordinates.

## Consequences

- The real telescope can be brought up, measured and tested while the demo keeps selling
  simulated sessions and taking sandbox payments.
- A full mission on the test observatory needs a booking, and it cannot be booked. The
  first end-to-end mission (DV-036) needs an operator path to it, which is the next piece
  of work; device checks, MAX_ALT_SAFE and the horizon survey do not.
- Operator telemetry and the web emergency park still answer 503 on the demo, since
  `/internal/*` stays closed to the internet (RUNBOOK §2). For an attended test the person
  at the mount is the emergency stop: Park, Ctrl-C, then power (RUNBOOK §7).
- When the real launch ends the demo, `DARKVIEW_HARDWARE_TEST_OBSERVATORY_ID` is removed
  with `DARKVIEW_DEPLOYMENT=demo`.
