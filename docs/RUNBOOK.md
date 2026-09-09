# Darkview runbook

Operational procedure for the Darkview Tbilisi Observatory: how to bring it up, how to
take it down, what to check, and what to do when something is wrong.

**Read `docs/SAFETY.md` first.** This document assumes it.

> **Status.** No hardware exists yet. Every procedure below has been exercised against
> `SimMount`, `SimCamera` and `SimFocuser` only. Sections marked **[UNEXERCISED]** describe
> what the code will do against real hardware and have never been performed on a
> telescope. They are instructions, not evidence. DV-034 through DV-038 are what turn them
> into evidence.

## 1. What is running

Three processes, none of them interchangeable.

| Process | Where | Port | Command |
| --- | --- | --- | --- |
| API | cloud | 4000 | `npm run dev --workspace @darkview/api` |
| Realtime | cloud | 4001 | `npm run dev --workspace @darkview/realtime` |
| Observatory Agent | the observatory mini-PC | none | `agent/.venv/bin/python -m darkview_agent` |

The agent **listens on nothing**. It dials out to the realtime service and presents its
device token as `Authorization: Bearer`. If you are looking for the agent's port, there
isn't one, and that is the design.

The realtime service must be served from the **same host** as the web app, on a path — not
on a `realtime.` subdomain. The session cookie is `__Host-` prefixed in production, so the
browser sends it only to the host that set it.

## 2. Bringing the cloud up

```bash
npm install
npm run db:generate
npm run contracts:check      # must be green before anything else
npm run db:migrate
npm test
```

`contracts:check` failing means a generated artefact has drifted from
`contracts/openapi.yaml`. Regenerate with `npm run contracts:generate` and commit the
result. Never hand-edit a generated file.

### Required environment

Both services refuse to start if any of these is missing. None has a default, and that is
deliberate — a permissive fallback silently disables the check it stands for.

| Variable | Service | Why it has no default |
| --- | --- | --- |
| `DATABASE_URL` | both | — |
| `AUTH_SECRET` | api | Signs sessions. ≥ 32 characters. |
| `APP_URL` | realtime | The only origin a mission-channel handshake may come from. A fallback would let any site open a subscription as a signed-in customer. |
| `STREAM_SIGNING_SECRET` | realtime | Signs live-view URLs (ADR-011). ≥ 32 characters. A known fallback is worse than no signing, because it looks like it works. |
| `EMAIL_VERIFICATION_WEBHOOK_URL` / `_SECRET` | api | Registration is refused without them. |
| `S3_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | both | Object storage (ADR-012). Both services refuse to start without them: a Collection whose every download is broken is worse than a server that says why it will not come up. |

`STREAM_SIGNING_SECRET` is separate from `AUTH_SECRET` on purpose: one signs sessions, the
other signs view-only URLs, and a key used for two jobs cannot be rotated for one of them.

`TRUSTED_PROXY_HOPS` does have a default -- zero -- and it is the cautious one: no address
in `X-Forwarded-For` is trusted, so rate limiting falls back to metering by account. **Set
it to the real number of proxies in front of the API before going live.** Left at zero the
per-address cap on new account creation is off, because keyed on the unattributed fallback
it would be a single bucket shared by every customer in the world. Count the proxies that
append to the header, not the hops the packet takes; if the number is wrong in the high
direction every request is unattributed, and in the low direction a caller can name their
own bucket.

### Seeding

`npm run db:seed` refuses to run unless `NODE_ENV=development`. It writes demo users, a
demo observatory and a demo device token, and the guard exists so an unset variable cannot
put fake telescope data into a real database. The token is printed when the seed runs and
is development-only.

## 3. Bringing the observatory up

### Simulated — the default, and the only mode used in normal work

```bash
export DARKVIEW_AGENT_OBSERVATORY_ID=<uuid>
export DARKVIEW_AGENT_CLOUD_URL=wss://…/ws/agent
export DARKVIEW_AGENT_DEVICE_TOKEN=<token>
agent/.venv/bin/python -m darkview_agent
```

The agent refuses to start without those three. One that cannot reach the cloud cannot be
told to stop.

Expect this on a healthy start:

```
agent starting: driver_mode=SIMULATED attended=False
safety envelope: UNMEASURED — every slew will be refused with
  SAFETY_ENVELOPE_UNMEASURED until MAX_ALT_SAFE is measured
local state: ~/.darkview/agent-state.sqlite3
agent running; watchdog thread up
```

**The UNMEASURED warning is correct and expected.** It is not a misconfiguration to fix by
setting a number. See §5.

If site coordinates are unset you will also see a warning that the Sun's position cannot
be computed, and every slew will be refused. Also correct.

### Real hardware — **[UNEXERCISED]**

```bash
export DARKVIEW_AGENT_DRIVER_MODE=REAL
export DARKVIEW_AGENT_ATTENDED=1
```

Both, or the agent refuses to start. `ATTENDED` means an operator is **physically present
at the observatory**, watching the mount, able to cut power. It is not a configuration
convenience and must never be set in a service unit, a container image, a CI job or a
`.env` file that outlives the session.

No autonomous, scheduled or background session may command real hardware.

## 4. Bringing it down

```
Ctrl-C, or SIGTERM
```

The agent parks the mount on shutdown. A clean stop is still a stop, and the mount does
not know the difference between an operator pressing Ctrl-C and a crash.

The local state store is closed *after* the park, so an audit event the park writes still
has somewhere to go.

**Do not `kill -9` a running agent.** It skips the park. If you have already done it, see
§7.1.

## 5. Measuring `MAX_ALT_SAFE` — **[UNEXERCISED]**

This is DV-034 and it is a **blocking external dependency**, not engineering work. Until
it is done, both the cloud and the agent refuse every slew, and that refusal is the system
working correctly.

The measurement is read off the assembled optical train — the actual telescope, with the
actual camera and the actual dew shield fitted — by raising the altitude in five-degree
steps **with the power off** and watching the rear of the camera train against the fork
base. The value recorded is the last altitude with clearance, not the first with contact.

It is never calculated, never taken from a specification sheet, never copied from another
installation, and never guessed. Changing the camera, the focuser, the dew shield or the
dovetail invalidates it and it must be measured again.

Recording it requires its provenance — `setSafetyEnvelope` refuses a value without
`maxAltitudeMeasuredAt` and `maxAltitudeMeasuredBy`. A number with no measurer is
somebody's guess.

The full Q1–Q9 mount qualification, of which this is one step, belongs to DV-034 and its
acceptance criteria. It also needs the **site compass survey** that produces the horizon
mask, and the cable-wrap sectors, before a real mission is permitted.

## 6. Before and after a session

### Before — **[UNEXERCISED for the hardware rows]**

- [ ] `npm run contracts:check` green.
- [ ] Agent log shows `agent running; watchdog thread up`.
- [ ] Link is `ONLINE` — the agent is heartbeating and the cloud has welcomed it.
- [ ] Safety envelope present and `maxAltitudeDegrees` non-null.
- [ ] Site coordinates set; no Sun warning in the log.
- [ ] Sun is below `daylightLockSunAltitudeDegrees`.
- [ ] Mount is parked and the drive is free of obstruction.
- [ ] Dew shield, camera and cabling as they were when `MAX_ALT_SAFE` was measured.

### After

- [ ] Mission reached a terminal state, or was explicitly cancelled.
- [ ] Mount is parked.
- [ ] Agent log holds no unexplained `WATCHDOG_TRIGGERED` event.
- [ ] Any `REJECTED` ack carrying a `SAFETY_` reason is understood before the next session.

That last one matters. A cloud-approved command refused locally is the two-check design
working, but it also means the two sides disagreed about something, and the disagreement
is worth understanding.

## 7. When something is wrong

### 7.1 The mount is pointing somewhere it should not be

**[UNEXERCISED]** In order of preference:

1. **Send `PARK`.** It is never refused on safety-envelope grounds — Park is the answer to
   every unresolved condition and moves the mount to a known-safe position by definition.
2. **Stop the agent** (`Ctrl-C` / SIGTERM). It parks on shutdown.
3. **Wait out `linkDeadSeconds`.** Cut the link and the watchdog parks with no cloud
   involvement, including when the cloud has never been reachable.
4. **Cut power at the mount.** Last resort. It leaves the mount unparked and its position
   unknown, which means re-homing before the next session.

There is currently **no operator emergency-park button**. `Watchdog.operator_abort` has no
caller outside an `ABORT` command envelope, so an operator's stop today is a command sent
as the session owner, or option 2 or 3 above. DV-063 owes the operator console.

### 7.2 The agent will not start

| Log line | Cause | Fix |
| --- | --- | --- |
| `DARKVIEW_AGENT_DRIVER_MODE=REAL … ATTENDED is not set` | Real drivers requested with no operator present. | Be at the observatory, or use the simulator. Do not set `ATTENDED` to get past it. |
| `refusing to start: set DARKVIEW_AGENT_OBSERVATORY_ID, …` | Cannot dial out. | Supply all three. |
| `… is not a UUID` | Malformed observatory id. | It must match the record the device token belongs to. |
| `SITE_LATITUDE and SITE_LONGITUDE must be set together` | Half a position. | Both or neither. |

### 7.3 The agent starts but never comes online

```
link down (peer closed the connection); retrying in 1.0s
link down (peer closed the connection); retrying in 2.0s
…
watchdog: HEARTBEAT_LOST
watchdog: LINK_DEAD
```

Backoff doubles to a 60 s ceiling. The watchdog fires on schedule regardless, which is
correct — an observatory that booted into an outage still parks.

Check, in order: the realtime service is running; `DARKVIEW_AGENT_CLOUD_URL` ends in
`/ws/agent`; the observatory row has a `deviceTokenHash` (one without admits no agent);
the token matches; and the observatory is not already connected — the registry admits
exactly one link per observatory and closes the second with
`observatory already connected`.

A silent failure worth knowing about: if the agent's timestamps and the cloud's validators
disagree about spelling, **every message is refused at the parse step and the link never
reaches ONLINE**. This happened once — Python's `isoformat()` writes `+00:00` where the
generated Zod accepts only `Z`. `clock.py:wire_timestamp` is the fix, and
`test_wire_timestamps.py` is what keeps it fixed.

### 7.4 Every slew is refused

Two vocabularies, and it is worth knowing which you are looking at. Over HTTP the cloud
answers `409 SAFETY_REFUSED` and puts the specific rule in `details.rejectionReason`. Over
the agent link, the same rule arrives as a `REJECTED` ack whose `rejectionReason` is that
value. Read the `CommandRejectionReason` either way — it names the rule.

| Reason | Meaning |
| --- | --- |
| `SAFETY_ENVELOPE_UNMEASURED` | `MAX_ALT_SAFE` is null. §5. Not a bug. |
| `SAFETY_SUN_EXCLUSION` | Too close to the Sun — **or** site coordinates are unset, so the Sun cannot be computed. Both fail closed. |
| `SAFETY_DAYLIGHT_LOCK` | The Sun is up. The only overridable rule, attended only. |
| `SAFETY_ABOVE_MAX_ALTITUDE` | Past the measured clearance. |
| `SAFETY_HORIZON_MASK` | Below the surveyed horizon at that bearing. |
| `SAFETY_FORBIDDEN_AZIMUTH` | Inside a cable-wrap sector. |
| `SAFETY_NUDGE_LIMIT_EXCEEDED` | Cumulative nudge would leave the budget. The control re-centres. |

### 7.5 The watchdog fired

Every trigger writes `WATCHDOG_TRIGGERED` **before** touching a device, so the record
exists even if the process died mid-action. Read it: it carries the trigger, the detail,
and whether capture-stop and park were attempted.

| Trigger | Meaning |
| --- | --- |
| `HEARTBEAT_LOST` | Capture stopped, mount still tracking. Recovers on its own when the link returns. |
| `LINK_DEAD` | Mount parked. |
| `DEVICE_FAULT` | A driver raised. Capture stopped, mount parked. |
| `OPERATOR_ABORT` | An `ABORT` envelope arrived. |
| `WEATHER_UNSAFE` | **Cannot currently occur.** Nothing reads weather. DV-039. |

**If `park_failure` is set, the mount did not park.** Treat it as a physical incident: go
to the observatory. The abort and the park are attempted independently, so a mount that
refused to abort may still have parked — the record says which.

### 7.6 The live view is blank

The customer holds a `MISSION_STREAM` URL and gets nothing. Every refusal on that path is
the same 404 by design, so diagnose from the service side, not the response:

1. Are frames arriving? A mission that has never produced one is offered no URL at all —
   `MISSION_STREAM` is sent only once a frame has actually arrived.
2. Has the mission reached a terminal state? Frames are released on mission end, on agent
   link loss, and after 30 s of silence.
3. Is `STREAM_SIGNING_SECRET` the same value the service started with? Rotating it
   invalidates every outstanding URL immediately.
4. Is the viewer still entitled? Entitlement is re-checked on **every** request, so an
   ended session or a withdrawn observer seat stops the stream on the next fetch rather
   than when the token lapses.

Frames live only in the memory of the realtime process holding the agent socket. A second
instance would not have them — see `docs/network-future.md`.

### 7.7 A mission is stuck and the observatory will not take another

`Mission_active_per_observatory_unique` is a partial unique index: one live mission per
observatory. A mission left in a live state holds the observatory shut against every later
booking.

This is intended, and the recovery is intended too. When the agent reconnects it reports
`resumeMissionId` from its local state store; the cloud resolves that mission and tells the
agent the session is revoked. If a mission is stuck with no agent to resume it, an operator
must move it to a terminal state — there is no automatic timeout, deliberately.

## 8. Backup and disaster recovery

### What is backed up, and what is not

One PostgreSQL database holds everything the platform knows: accounts, bookings, missions,
captures, the audit trail and the measured safety envelope. `npm run backup` dumps it.

Three things are deliberately outside that dump.

| Not backed up | Why |
| --- | --- |
| The agent's local state store (`~/.darkview/agent-state.sqlite3`, ADR-010) | It is a crash-recovery journal, not a record. **It must never be copied between observatories** — it names that observatory's sessions, users and missions, and restoring one elsewhere would hand a machine another site's session identities. An agent that loses it reconnects and is told what is true. |
| Capture image bytes | They will live in object storage (ADR-012), which is not provisioned yet. Object storage has its own durability and its own restore path; when it exists, this section gains a row and the drill gains a step. |
| Secrets | `AUTH_SECRET`, `STREAM_SIGNING_SECRET` and the device tokens are not in the database and are not in the dump. They are restored from wherever they are held, and a restore is a reasonable moment to rotate them. |

### Taking one

```bash
npm run backup              # writes ./backups/<database>-<utc timestamp>.dump
npm run backup /some/path   # or somewhere else
```

It refuses rather than writes in three cases, and each refusal means there is no backup:
`pg_dump` older than the server (a dump from an older client can be silently incomplete);
an archive it cannot read back with `pg_restore --list`; and an archive holding no data
entry for the core tables, which is what a dump of an unmigrated database looks like.

`backups/` and `*.dump` are in `.gitignore`. A dump is real customer data.

### Restoring one

**This is the destructive one.** There is no default target, nothing is read from
`DATABASE_URL`, and the target database has to be typed out twice:

```bash
npm run restore -- \
  --from backups/darkview-2026-09-08T14-17-18-451Z.dump \
  --to postgresql://user:password@host:5432/darkview \
  --confirm darkview
```

`--confirm` must equal the database named in `--to`. The two disagreeing is the shape of a
restore aimed at the wrong database, so it refuses — before touching anything.

**Every session in the backup is revoked on restore.** A restored `Session` row is a live
cookie from a past moment: whoever held it then holds it again now, including anyone who
held one because the incident being recovered from handed it to them. Everyone signs in
again. `--keep-restored-sessions` opts out and must not be used while recovering from
anything that might have leaked a session.

Against production this is a maintainer action, taken deliberately, in a session where the
maintainer asked for it. Nothing here is automated.

### After a restore

1. **Check the observatory is not mid-mission.** A restored database can hold a mission in
   a live state that no agent is running. §7 covers a stuck mission; the recovery is the
   same and an operator must move it to a terminal state.
2. **Restart the realtime service.** It holds the agent link and the live-frame store in
   memory, and neither is in the dump.
3. **Expect the agent to reconcile itself.** It reconnects, reports `resumeMissionId` from
   its own store, and the cloud tells it what is true. Do not copy anything onto it.
4. **Confirm `MAX_ALT_SAFE`.** If the restored `SafetyEnvelope` is older than the last
   measurement, every slew is refused until it is re-recorded — which is the system
   working, not a fault to route around. Never seed a value to clear it.

### The drill

`apps/api/src/lib/backup/restore-drill.integration.test.ts` runs on every pull request. It
takes a real dump, restores it into a scratch database, and asserts that every table and
every index *definition* came back, that the three partial unique indexes still carry the
`WHERE` clauses that make them correctness rather than convention, that the data is there,
and that the sessions are not.

A restore procedure nobody has run is a document. This is the only reason to believe this
section.

### What has never been done — **[UNEXERCISED]**

Everything above is exercised against a local or CI PostgreSQL by the drill. **None of it
has been run against production infrastructure, because there is none yet.** No retention
policy, no off-site copy, no schedule, and no measured recovery time exist. Those are
decisions for the maintainer when hosting is chosen, and this section will be wrong until
they are made:

- **Where backups are kept.** A dump beside the database it came from survives a bad
  migration and not a lost machine.
- **How often, and how much loss is acceptable.** Nothing here says an RPO because nobody
  has chosen one.
- **How long a restore takes on real data.** The drill restores a nearly empty database in
  seconds. That number means nothing about a year of captures.

## 9. What is not in this runbook

- **Production deployment and migrations.** Never run either unless the maintainer asks
  explicitly, in that session.
- **The Q1–Q9 qualification in full.** DV-034 owns it.
- **Weather procedure.** DV-039 owes the trigger; there is nothing to operate yet.
