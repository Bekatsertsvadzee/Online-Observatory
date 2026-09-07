# ADR-011 — How a live frame reaches the customer

- **Date:** 2026-09-07
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Arises from:** DV-060, which declined to implement `MISSION_STREAM` because this
  decision did not exist
- **Unblocks:** DV-032 (`stream/mjpeg.py`), DV-033 (`capture/pipeline.py`)

## Context

`contracts/openapi.yaml` describes two live-view paths and deliberately does not
join them.

**Going up**, the agent sends a `LiveFrameHeader` on its existing outbound socket:

> A LiveFrameHeader message is immediately followed by exactly one binary
> WebSocket frame carrying the encoded image bytes. Pixel data is never
> base64-encoded into JSON.

**Coming down**, the client is told a `MissionStreamInfo`:

> Where the client reads the live view. A short-expiry signed URL, never a device
> address.

carrying `streamUrl`, `encoding`, `mode` and `expiresAt`.

Nothing in the contract, in `docs/architecture.md`, in `docs/observatory-protocol.md`
or in any approved decision record says **where the bytes are held between those two
points, what serves them, or what signs the URL.** DV-060 built everything else on
the mission channel and stopped here rather than inventing an answer; a fabricated
`streamUrl` would have been worse than an absent one.

One detail in the contract settles more than it appears to. The `agentLink` channel
carries a `binary:` clause describing its frame convention. The `missionClient`
channel has no such clause — only `outbound`, `inbound` and a constraint that a
client may not send a `CommandEnvelope`. **The contract does not carry pixels on the
client channel.** That is not an omission to be filled in; it is why
`MissionStreamInfo` exists at all.

`CLAUDE.md` narrows what is left: no Redis, no message queues, no extra services
without a measured need and maintainer approval. The observatory accepts no inbound
connection from the internet or the LAN. And DV-060 already fixed that the realtime
service is served from the same host as the web app, on a path.

## Decision

**The realtime service terminates the frame stream, holds only the latest frame per
mission in memory, and serves it over HTTP from the same origin at a signed,
short-expiry path.**

```
agent  ──AGENT_LIVE_FRAME + binary frame──▶  apps/realtime
                                              |  latest frame per mission, in memory
                                              |
client ◀──MISSION_STREAM { streamUrl } ───────|  on /ws/mission/{missionId}
       ──GET /stream/mission/{id}?t=…────────▶|  multipart/x-mixed-replace
```

Three answers, one each to the three open questions:

**Where the bytes are held.** In the memory of the process that already holds the
socket. One frame per mission, replaced on arrival, never queued and never written
to disk, to the database, or to object storage. Freed when the mission ends, when
the session is revoked, or when the agent link drops.

**What serves them.** The realtime service's existing HTTP server, which today
answers `404` to everything that is not a WebSocket upgrade. `GET
/stream/mission/{missionId}` responds `multipart/x-mixed-replace`, which is what
`LiveFrameEncoding: JPEG` means in a browser and what an `<img>` element consumes
without a library.

**What signs the URL.** An HMAC over `missionId`, `userId` and the expiry, keyed by
a service secret, checked **in addition to** the session cookie — which the browser
sends anyway, because the service is same-host by DV-060's constraint. The cookie
proves the viewer is signed in now; the token proves the URL was minted for this
viewer and bounds how long a copied `src` attribute keeps working.

`MISSION_STREAM` is sent only once a frame for that mission has actually arrived.

## Why

- **The memory is one JPEG.** One active mission per observatory, one observatory
  in Phase 1. A "buffer" here is a single frame, and the bound is structural rather
  than configured.
- **Latest-frame-wins is what a live view means.** A customer nudging a telescope
  must see the sky now, not a backlog. Queueing frames would convert a dropped
  frame — which nobody notices — into growing latency, which everybody does.
- **No new service, no new port, no new dependency.** The process exists, the HTTP
  server exists, the socket exists. This adds a route.
- **A live frame is not evidence and is never kept.** The kept artefact is a
  Capture, and DV-061 owns it, with object storage and a Collection. Conflating the
  two would put every discarded viewfinder frame into permanent storage.
- **The observatory is still unreachable.** The client addresses the cloud. Nothing
  about this gives anyone an address for the mount, the camera, or the mini-PC.

## Alternatives considered

**Binary frames on the mission WebSocket.** The client already holds
`/ws/mission/{missionId}`, so the frames could go down it. Rejected on two grounds.
The contract gives that channel no binary clause while giving the agent link one,
and `MissionStreamInfo` would have no reason to exist if pixels went down the
socket. And practically: it would put frame bandwidth through the same connection as
mission state, where one slow reader delays the telemetry and the command verdicts
behind a backlog of stale images.

**Object storage, one object per frame.** Rejected. It adds a network round trip to
every frame in each direction, costs per request for data that is stale in
milliseconds, and blurs the line between the live view and the Capture that DV-061
deliberately draws.

**A `bytea` column.** Rejected. Continuous write churn, WAL amplification and vacuum
pressure, for data whose useful life is shorter than the transaction that stores it.

**Redis or a broker.** Excluded by `CLAUDE.md` absent a measured need. The need here
is to hold one image.

**WebRTC.** The contract already answers this: "Phase 1 delivers MJPEG. WebRTC is a
Phase 2 change and requires an approved decision record." Not this one.

**The agent serving frames directly.** Refused outright, not weighed. The
observatory accepts no inbound connection, and no browser may address it.

## Consequences

- The realtime service gains its first HTTP surface beyond the upgrade handshake.
  It must authenticate every request, and it must answer identically whether a
  mission has no frames or does not exist — the same refusal discipline the mission
  channel already applies.
- **A new secret is required**: a stream-signing key, with no default, in
  `.env.example` and in the deployment environment before the service starts. The
  same reasoning as `APP_URL` in DV-060 — a permissive fallback would silently
  disable the check.
- Frames live in the process holding the socket. A second realtime instance would
  not have them. That is the same limitation ADR-009 records for `LISTEN`/`NOTIFY`,
  it is acceptable for the same reason, and it belongs in `docs/network-future.md`
  rather than being solved now.
- Observers (DV-103) read the same per-mission frame. The fan-out is already a set
  per mission, so this is a permission question, not a plumbing one.
- `MissionStreamInfo.mode` carries `SIMULATED` for a simulated mission, and the
  client must present it as such. Simulator output is never shown as telescope
  output.
- Memory must be released explicitly on mission end, session revocation and link
  loss. A frame retained after a mission is a leak in a long-lived process.

## What this deliberately does not decide

- **Frame rate, resolution and JPEG quality.** DV-032 measures those against the
  real ASI585MC and the real uplink. No number belongs here.
- **Live stack cadence and how a stacked frame differs from a sub-exposure.**
  DV-033. `LiveFrameHeader.stackedFrames` is where it surfaces.
- **Recording or replaying a live view.** Not Phase 1.

## When this would be revisited

- A move to WebRTC, which needs its own decision record.
- More than one realtime instance, or more than one observatory streaming at once.
- Measured latency that MJPEG over HTTP does not meet on the observatory's real
  uplink.

None of these apply in Phase 1.
