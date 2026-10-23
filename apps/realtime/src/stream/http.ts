import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { LiveFrameEncoding } from "@darkview/contracts";

import { authenticateClient } from "@/auth/user-session";
import type { MissionChannelStore } from "@/mission/store";
import type { LiveFrame } from "@/stream/frames";
import type { LiveStream } from "@/stream/live-stream";

const STREAM_PATH = /^\/stream\/mission\/([0-9a-fA-F-]{36})$/;
const SPECTATE_PATH = /^\/stream\/mission\/([0-9a-fA-F-]{36})\/spectate$/;

/** Clients ADR-066 §3 and §4: one frame every four seconds, twenty at once. */
export const SPECTATOR_FRAME_INTERVAL_MS = 4000;
export const SPECTATOR_CAPACITY = 20;
/** How often a running spectator stream asks whether the session is still open to it. */
export const SPECTATOR_RECHECK_MS = 15_000;
/** A spectator stream's outer bound; the recheck ends it long before, normally. */
const SPECTATOR_MAX_MS = 2 * 60 * 60_000;

/** Spectators watching each mission now, held in memory and nowhere else (ADR-066). */
export class SpectatorGate {
  private readonly counts = new Map<string, number>();

  constructor(private readonly capacity = SPECTATOR_CAPACITY) {}

  tryAdmit(missionId: string): boolean {
    const count = this.counts.get(missionId) ?? 0;
    if (count >= this.capacity) return false;
    this.counts.set(missionId, count + 1);
    return true;
  }

  release(missionId: string): void {
    const count = (this.counts.get(missionId) ?? 1) - 1;
    if (count <= 0) this.counts.delete(missionId);
    else this.counts.set(missionId, count);
  }

  watching(missionId: string): number {
    return this.counts.get(missionId) ?? 0;
  }
}

const defaultGate = new SpectatorGate();

const CONTENT_TYPE_FOR: Record<LiveFrameEncoding, string> = {
  JPEG: "image/jpeg",
};

export type StreamDependencies = {
  store: MissionChannelStore;
  stream: LiveStream;
  now?: () => Date;
  spectators?: SpectatorGate;
};

/**
 * Serve one live view as `multipart/x-mixed-replace`.
 *
 * Returns whether this was a stream request at all, so the caller falls through
 * to its own 404 for everything else.
 *
 * MJPEG over a replacing multipart body is what `LiveFrameEncoding: JPEG` means
 * in a browser: an `<img src>` consumes it with no library, no player and no
 * second protocol. WebRTC is a Phase 2 change and needs its own decision record.
 *
 * **Every refusal is the same 404.** Not signed in, forged token, expired token,
 * a token minted for somebody else, a mission that does not exist, a mission with
 * no frames yet, a viewer whose seat was withdrawn -- one answer, no detail. The
 * mission channel already refuses on that rule, and a second surface answering
 * more precisely would undo it: somebody enumerating mission ids must not be able
 * to tell "not yours" from "not a mission".
 */
export async function handleStreamRequest(
  dependencies: StreamDependencies,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const spectate = SPECTATE_PATH.exec(url.pathname);
  if (spectate) {
    await spectateMission(dependencies, request, response, spectate[1]);
    return true;
  }
  const path = STREAM_PATH.exec(url.pathname);
  if (!path) return false;

  const at = (dependencies.now ?? (() => new Date()))();
  const admitted =
    request.method === "GET"
      ? await authorise(dependencies, request, path[1], url, at)
      : null;

  if (!admitted) {
    response.writeHead(404, { "cache-control": "no-store" }).end();
    return true;
  }

  stream(dependencies.stream, response, admitted.frame, admitted.expiresAt, at);
  return true;
}

type Admission = { frame: LiveFrame; expiresAt: Date };

/**
 * Three independent checks, all of which must pass.
 *
 * The **cookie** (or a native client's bearer token, ADR-061) proves somebody is signed
 * in right now. The **token** proves this
 * URL was minted for that same person, and bounds how long a copied `src` keeps
 * working. The **store** proves they are still entitled -- the controller of a live
 * session, or an observer whose seat has not been withdrawn.
 *
 * The third is what keeps the token from being a five-minute bearer credential.
 * A controller who ends their session, or an observer the controller closed the
 * mission against, stops being served on their next request rather than whenever
 * the token happens to lapse.
 */
async function authorise(
  { store, stream }: StreamDependencies,
  request: IncomingMessage,
  missionId: string,
  url: URL,
  now: Date,
): Promise<Admission | null> {
  const token = url.searchParams.get("t");
  if (!token) return null;

  const user = await authenticateClient(store, request.headers, now);
  if (!user) return null;

  const grant = stream.verify(token, missionId, user.id, now);
  if (!grant) return null;

  if (!(await store.mayWatchMission(missionId, user.id, now))) return null;

  // Last, because it is the only absence that is ordinary rather than a refusal:
  // a subscriber whose agent has not sent a frame yet.
  const frame = stream.latest(missionId);
  return frame ? { frame, expiresAt: grant.expiresAt } : null;
}

/**
 * Clients ADR-066: the view of a session its owner opened to Tonight, live. No sign-in
 * and no token -- the owner's open flag is the grant, asked now and every
 * SPECTATOR_RECHECK_MS while it runs. Not open, not live or no frame yet is the same
 * 404 the signed stream gives; a full house is 503, so the page can say so and offer
 * a booking instead.
 */
async function spectateMission(
  {
    store,
    stream: live,
    now = () => new Date(),
    spectators = defaultGate,
  }: StreamDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  missionId: string,
): Promise<void> {
  const frame =
    request.method === "GET" && (await store.isOnTonight(missionId))
      ? live.latest(missionId)
      : null;
  if (!frame) {
    response.writeHead(404, { "cache-control": "no-store" }).end();
    return;
  }
  if (!spectators.tryAdmit(missionId)) {
    response.writeHead(503, { "cache-control": "no-store", "retry-after": "30" }).end();
    return;
  }

  const at = now();
  stream(live, response, frame, new Date(at.getTime() + SPECTATOR_MAX_MS), at, {
    minIntervalMs: SPECTATOR_FRAME_INTERVAL_MS,
    stillAllowed: () => store.isOnTonight(missionId),
    onFinish: () => spectators.release(missionId),
  });
}

type StreamOptions = {
  /** Write no faster than this: a spectator's lower rate (ADR-066 §3). */
  minIntervalMs?: number;
  /** Asked every SPECTATOR_RECHECK_MS; the stream ends the first time it says no. */
  stillAllowed?: () => Promise<boolean>;
  onFinish?: () => void;
};

/**
 * Write frames until the mission stops, the client leaves, or the grant lapses.
 *
 * Latest-frame-wins under backpressure: if the socket has not drained, the frame
 * is dropped rather than buffered. A slow reader must fall behind in quality, not
 * in time -- buffering would show somebody the sky as it was minutes ago while
 * they nudged a telescope and saw nothing move.
 */
function stream(
  live: LiveStream,
  response: ServerResponse,
  first: LiveFrame,
  expiresAt: Date,
  now: Date,
  options: StreamOptions = {},
): void {
  const boundary = `darkview-${randomUUID()}`;
  let writable = true;
  let finished = false;

  response.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${boundary}`,
    // Never cached, by the browser or by anything in between. A cached frame is a
    // stale telescope image presented as the current one.
    "cache-control": "no-store, no-transform",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    connection: "close",
  });

  let lastWrittenAt = 0;
  const write = (frame: LiveFrame) => {
    if (!writable || finished) return;
    const at = Date.now();
    if (options.minIntervalMs && at - lastWrittenAt < options.minIntervalMs) return;
    lastWrittenAt = at;
    writable = response.write(part(boundary, frame));
  };

  response.on("drain", () => {
    writable = true;
  });

  write(first);

  const stop = live.listen(first.missionId, { frame: write, end: () => finish() });

  // The response ends when the grant does. A subscribed client has held a renewed
  // MISSION_STREAM for a full minute by then -- see STREAM_RENEWAL_LEAD_SECONDS --
  // and swaps to the new URL without a gap. One that is no longer subscribed
  // simply stops, which is the point of a short expiry.
  const deadline = setTimeout(
    () => finish(),
    Math.max(0, expiresAt.getTime() - now.getTime()),
  );

  const recheck = options.stillAllowed
    ? setInterval(() => {
        void options.stillAllowed?.().then(
          (allowed) => {
            if (!allowed) finish();
          },
          () => finish(),
        );
      }, SPECTATOR_RECHECK_MS)
    : null;

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    if (recheck) clearInterval(recheck);
    stop();
    response.end();
    options.onFinish?.();
  }

  // Fires whether the client navigated away or the socket died. Without it every
  // abandoned tab leaves a listener on the mission for as long as the process runs.
  response.on("close", finish);
}

function part(boundary: string, frame: LiveFrame): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: ${CONTENT_TYPE_FOR[frame.encoding]}\r\n` +
      `Content-Length: ${frame.bytes.byteLength}\r\n\r\n`,
    "ascii",
  );
  return Buffer.concat([head, frame.bytes, Buffer.from("\r\n", "ascii")]);
}
