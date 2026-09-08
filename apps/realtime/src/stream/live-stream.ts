import type { LiveFrameEncoding, ObservatoryMode } from "@darkview/contracts";

import {
  LiveFrameStore,
  type FrameListener,
  type LiveFrame,
} from "@/stream/frames";
import {
  STREAM_TOKEN_TTL_SECONDS,
  signStreamToken,
  verifyStreamToken,
  type StreamGrant,
} from "@/stream/token";

/** `/stream/mission/{missionId}`, the path ADR-011 names. */
export const streamPathFor = (missionId: string) => `/stream/mission/${missionId}`;

/** What the client is told: a signed URL, when it expires, and under what mode. */
export type StreamOffer = {
  streamUrl: string;
  expiresAt: Date;
  encoding: LiveFrameEncoding;
  mode: ObservatoryMode;
};

/**
 * What the mission channel needs to hand a customer a live view.
 *
 * An interface rather than the class, for the same reason `MissionBroadcast` is
 * one: the channel depends on "mint me an offer, or tell me there is nothing to
 * watch" and not on where frames are kept.
 */
export interface StreamOffers {
  /**
   * A URL for this viewer, or null when this mission has produced no frame.
   *
   * Null is the whole reason this returns an option. ADR-011: MISSION_STREAM is
   * sent only once a frame has actually arrived, because a URL offered before then
   * is one the client fetches, is refused, and has no way to retry.
   */
  offer(missionId: string, userId: string, now: Date): StreamOffer | null;
}

/**
 * The live view, end to end inside this process.
 *
 * Holds the frames, signs the URLs and hands out the readers. One object because
 * ADR-011 is one decision: the process that already holds the observatory socket
 * keeps the latest frame and serves it from the same origin. Splitting the
 * signing key away from the frames would buy nothing -- there is no second place
 * either could live.
 */
export class LiveStream implements StreamOffers {
  private readonly frames = new LiveFrameStore();

  constructor(
    /**
     * The web app's origin. `MissionStreamInfo.streamUrl` is `format: uri` and the
     * generated validator enforces it, so the offer must be absolute -- and the
     * origin has to be the app's, because the `__Host-` session cookie the stream
     * request needs is only ever sent to that host.
     */
    private readonly appUrl: string,
    /**
     * The stream-signing key. No default anywhere in the stack: a fallback here
     * would leave the signature check running against a value an attacker knows,
     * which is worse than not signing, because it looks like it works.
     */
    private readonly secret: string,
  ) {}

  publish(frame: LiveFrame): void {
    this.frames.publish(frame);
  }

  release(missionId: string): void {
    this.frames.release(missionId);
  }

  releaseObservatory(observatoryId: string): number {
    return this.frames.releaseObservatory(observatoryId);
  }

  releaseStale(at: number): number {
    return this.frames.releaseStale(at);
  }

  latest(missionId: string): LiveFrame | null {
    return this.frames.latest(missionId);
  }

  listen(missionId: string, listener: FrameListener): () => void {
    return this.frames.listen(missionId, listener);
  }

  offer(missionId: string, userId: string, now: Date): StreamOffer | null {
    const frame = this.frames.latest(missionId);
    if (!frame) return null;

    const expiresAt = new Date(now.getTime() + STREAM_TOKEN_TTL_SECONDS * 1000);
    const url = new URL(streamPathFor(missionId), this.appUrl);
    url.searchParams.set("t", signStreamToken({ missionId, userId, expiresAt }, this.secret));

    return {
      streamUrl: url.toString(),
      expiresAt,
      encoding: frame.encoding,
      // The mode of the frames actually arriving, not of the mission as booked.
      mode: frame.mode,
    };
  }

  /**
   * Check a token a client presented, against the mission and viewer it must name.
   *
   * Verification lives here rather than in the HTTP handler so the signing key
   * never leaves this object. The handler asks a question and gets a yes or a no;
   * it has no copy of the secret to leak into a log line or an error message.
   */
  verify(
    token: string,
    missionId: string,
    userId: string,
    now: Date,
  ): StreamGrant | null {
    const verdict = verifyStreamToken(token, this.secret, now);
    if (!verdict.ok) return null;
    if (verdict.grant.missionId !== missionId) return null;
    if (verdict.grant.userId !== userId) return null;
    return verdict.grant;
  }

  get size(): number {
    return this.frames.size;
  }
}

/**
 * What the agent link may do with a frame it received.
 *
 * Narrower than the class on purpose: nothing on the observatory's side of the
 * process has any reason to mint a customer's URL.
 */
export interface LiveFrameSink {
  publish(frame: LiveFrame): void;
  release(missionId: string): void;
}
