import type { ObservatoryMode } from "@darkview/contracts";

import type { LiveFrame } from "@/stream/frames";
import type { LiveFrameSink, StreamOffer, StreamOffers } from "@/stream/live-stream";
import { STREAM_TOKEN_TTL_SECONDS } from "@/stream/token";

/**
 * A StreamOffers for tests, with the frame's presence under the test's control.
 *
 * Records who it minted for, which is what lets a test assert the thing that
 * actually matters about a signed URL: that one customer's offer is not another
 * customer's. A shared stub returning one fixed string could not tell the
 * difference.
 */
export class FakeStreamOffers implements StreamOffers {
  readonly minted: { missionId: string; userId: string; at: Date }[] = [];

  /** Missions that have produced a frame. Empty by default -- no frame, no offer. */
  readonly streaming = new Set<string>();
  mode: ObservatoryMode = "SIMULATED";

  offer(missionId: string, userId: string, now: Date): StreamOffer | null {
    if (!this.streaming.has(missionId)) return null;

    this.minted.push({ missionId, userId, at: now });
    return {
      streamUrl: `https://darkview.test/stream/mission/${missionId}?t=for-${userId}-${this.minted.length}`,
      expiresAt: new Date(now.getTime() + STREAM_TOKEN_TTL_SECONDS * 1000),
      encoding: "JPEG",
      mode: this.mode,
    };
  }
}

/**
 * A LiveFrameSink that records rather than stores.
 *
 * The relay's tests use it to assert that a frame reaching the fan-out is
 * actually published and that a finished mission is actually released -- the two
 * things a no-op sink would let pass silently.
 */
export class RecordingFrameSink implements LiveFrameSink {
  readonly published: LiveFrame[] = [];
  readonly released: string[] = [];

  publish(frame: LiveFrame): void {
    this.published.push(frame);
  }

  release(missionId: string): void {
    this.released.push(missionId);
  }
}
