# ADR-012 — Where a capture is stored, and who writes it

- **Date:** 2026-09-08
- **Status:** APPROVED
- **Decided by:** project maintainer
- **Arises from:** DV-061, which recorded captures and built the Collection but
  stopped at the bytes
- **Blocks:** `GET /captures/{captureId}/download`, the agent's capture pipeline,
  and DV-033

## Context

`contracts/openapi.yaml` describes both ends of a capture and does not join them.

**Going up**, the agent reports `AgentCaptureReady` carrying storage keys:

> `imageStorageKey`: Object storage key written by the agent. Not a URL and never
> a public path.

**Coming down**, the customer is offered a download:

> Object storage buckets are never public. Every download is a signed URL.

DV-061 built everything between those two points that does not need the bytes: the
`Capture` row, its `CaptureAsset` keys, the owner's `CaptureAccess`, the
`MISSION_CAPTURE_READY` push and the Collection endpoints. What it could not build
is the part that requires knowing **which store the keys name, and how the agent
comes to be allowed to write into it.**

Three things constrain the answer.

**The observatory is the least-trusted machine we operate.** It is a mini-PC on a
rooftop, physically reachable, and the entire security posture around it is that it
holds no standing authority: it accepts no inbound connection, opens no port, and
carries exactly one credential — a device token that the cloud issues, scopes to
one observatory, and can revoke in a single row.

**Captures are large and FITS are larger.** A stacked image is megabytes; the raw
frame data behind it is tens of megabytes. This is not live-view traffic, which
ADR-011 sized at one JPEG.

**The realtime process holds the telescope's control socket.** ADR-011 already
refused to put frame bandwidth through the mission channel because one slow reader
would delay telemetry and command verdicts. The same objection applies with more
force to a capture.

## Decision

**Object storage is S3-compatible. The agent writes the objects itself, but never
holds a bucket credential: it asks the cloud for a per-object, short-expiry
presigned `PUT` over its existing authenticated link, and uploads to that URL.
Downloads are presigned `GET` URLs minted by the API against the requesting
customer.**

```
agent  ──"I have a capture, give me somewhere to put it"──▶  cloud
       ◀──presigned PUT, one key, one method, minutes────────
       ──PUT bytes─────────────────────────────────────────▶  object storage
       ──AGENT_CAPTURE_READY { imageStorageKey, … }────────▶  cloud
                                                              records the Capture
customer ──GET /captures/{id}/download?kind=IMAGE──────────▶  cloud
         ◀──presigned GET, short expiry────────────────────
         ──GET────────────────────────────────────────────▶  object storage
```

Three answers, one each to the three open questions:

**Which store.** S3-compatible, addressed through the S3 API. The specific provider
is a maintainer choice and a separate, later one: the presigning code is identical
across AWS S3, Cloudflare R2, Backblaze B2 and MinIO, so nothing in the codebase
has to wait for it. The bucket is private. There is no public path and no CDN
origin in Phase 1.

**Who writes.** The agent, to a URL the cloud minted for exactly that object. The
observatory gains no lasting authority over the bucket and holds no key it could
leak. The key is derived by the cloud, not proposed by the agent, so a compromised
agent cannot choose to write over another customer's object.

**What signs a download.** The API, per request, against the caller — after the
same ownership check `GET /captures/{captureId}` already applies. The URL is
short-expiry and names one object.

## Why

- **A stolen mini-PC yields nothing but a revocable device token.** Under the
  alternative it would yield a long-lived credential that reads, overwrites and
  deletes every customer's images from anywhere on the internet, and revoking it
  would mean rotating a secret and redeploying the observatory.
- **Least authority, and it is not a new principle here.** The observatory already
  holds one credential the cloud can revoke in one row. A bucket key would be the
  first standing authority it has ever had, and the first thing about it that
  could not be revoked from the database.
- **The cloud derives the key.** An agent that proposed its own key could write
  outside its prefix. Deriving it cloud-side makes the object's identity a fact the
  cloud already knows, which is also what lets `CaptureAsset.storageKey` be trusted.
- **Bytes never pass through the process holding the telescope socket.** The same
  reasoning ADR-011 applied to live frames, and more so: a FITS is orders of
  magnitude larger than a frame.
- **The upload is retryable without a second record.** A presigned PUT that fails
  is re-requested; the capture is only recorded when the agent reports the key it
  actually wrote, and `Capture_command_unique` means a retry that races itself
  produces one row.

## Alternatives considered

**Long-lived bucket credentials on the agent.** The obvious reading of "written by
the agent", and rejected on the credential-exposure argument above. It is the only
option that puts an unrevocable, unscoped secret on the rooftop.

**Upload through the cloud over the existing WSS.** Rejected. It is the simplest
credential story — the agent already authenticates that socket — but it routes tens
of megabytes through the process that must never stall, for no security gain over a
presigned PUT.

**A separate upload endpoint on the API that proxies to storage.** Rejected for the
same bandwidth reason, plus it would put large multipart bodies through Next.js
route handlers, which is the shape of request a serverless deployment is worst at.

**Storing image bytes in PostgreSQL.** Rejected for the reasons ADR-011 already
recorded for frames, which apply more strongly to a permanent artefact: WAL
amplification, vacuum pressure, and a backup that grows without bound.

**A public bucket with unguessable keys.** Rejected outright. The contract says
"Object storage buckets are never public", and security by unguessable URL means an
image shared once is shared forever, with no revocation.

## Consequences

- **A new external dependency**, in the same class as the payment provider: an
  account, a bucket, and credentials that exist only in the cloud environment. It
  belongs in `docs/backlog.md` under blocking external dependencies.
- **New required secrets on the API and realtime services**, with no defaults, on
  the same reasoning as `STREAM_SIGNING_SECRET`: endpoint, region, bucket, access
  key and secret. A service that cannot sign must refuse to start rather than serve
  a Collection whose every download is broken.
- **The agent gains an outbound HTTPS destination** — the storage endpoint. It
  still accepts no inbound connection and still opens no port. `docs/SAFETY.md` §8
  needs a sentence saying so.
- **A new cloud-to-agent message** granting the presigned PUT, and an
  agent-to-cloud message asking for one. That is a **contract change**, and it is
  the first thing to do after this record is approved — not something to work
  around with a private endpoint.
- **Orphaned objects are possible** and must be tolerated: an agent that uploads and
  then loses the link before reporting leaves an object no row names. A sweep for
  unreferenced keys older than a day belongs with the operator tooling, not here.
- **`thumbnailUrl` stops being null.** Until this lands the Collection returns null
  for it, which is the contract's own word for "no thumbnail" and is honest; a
  fabricated path would be a broken image in every card.

## What this deliberately does not decide

- **Which provider.** A maintainer choice, and the code does not wait for it.
- **Retention.** How long a capture is kept, and what happens on account deletion.
  `Capture` holds `onDelete: Restrict` to `User` today, which means an account
  cannot currently be deleted at all while it owns captures. That is a real question
  and it is not this one.
- **The public gallery.** `CaptureVisibility.GALLERY` exists and nothing reads it.
  A published capture has a different access model and needs its own decision.
- **Watermarking.** `CaptureAssetKind` distinguishes `IMAGE` from `UNMARKED`, so
  the shape is decided; what the overlay says is DV-033's.

## When this would be revisited

- Egress cost at a volume Phase 1 will not reach.
- A CDN in front of the bucket, which would change what "never public" means and
  needs its own record.
- Any proposal to give the observatory a standing credential, which is the thing
  this record exists to refuse.
