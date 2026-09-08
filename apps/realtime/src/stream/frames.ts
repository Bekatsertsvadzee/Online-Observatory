import type { LiveFrameEncoding, ObservatoryMode } from "@darkview/contracts";

/**
 * How long a frame stays interesting.
 *
 * A live view is worth nothing once it is stale, and a mission that stops sending
 * frames -- the agent crashed, the network went, the operator pulled the plug --
 * emits no event saying so. Explicit release covers the paths that do signal
 * (mission ended, link closed); this covers the ones that do not, and is what
 * stops a month-long process accumulating the last frame of every mission it ever
 * carried.
 */
export const LIVE_FRAME_MAX_AGE_SECONDS = 30;

/**
 * One live-view frame, held in memory and nowhere else.
 *
 * Never written to disk, to the database or to object storage. A live frame is
 * not evidence: the kept artefact is a Capture, which DV-061 owns. Conflating the
 * two would put every discarded viewfinder frame into permanent storage.
 */
export type LiveFrame = {
  missionId: string;
  /** Carried so a dropped agent link can release exactly its own missions. */
  observatoryId: string;
  /**
   * SIMULATED or REAL, from the observatory row rather than from anything the
   * agent said about itself. It reaches the client in MissionStreamInfo, which is
   * how a UI knows not to present simulator output as telescope output.
   */
  mode: ObservatoryMode;
  encoding: LiveFrameEncoding;
  sequence: number;
  bytes: Buffer;
  receivedAt: number;
};

export type FrameListener = {
  frame(frame: LiveFrame): void;
  /** The mission stopped streaming: ended, released, or gone stale. */
  end(): void;
};

/**
 * The latest frame per mission, and who is watching it.
 *
 * **One frame per mission, replaced on arrival.** Not a buffer and not a queue.
 * Queueing would convert a dropped frame -- which nobody notices -- into growing
 * latency, which everybody does, and a customer nudging a telescope has to see
 * the sky now rather than a backlog of how it was.
 *
 * The bound is structural rather than configured: one active mission per
 * observatory, one observatory in Phase 1, so "the buffer" is a single JPEG.
 */
export class LiveFrameStore {
  private readonly frames = new Map<string, LiveFrame>();
  private readonly listeners = new Map<string, Set<FrameListener>>();

  publish(frame: LiveFrame): void {
    this.frames.set(frame.missionId, frame);
    // A copy, because a listener that fails writes to a dead socket and unsubscribes
    // itself from this very set. Mutating mid-iteration would silently skip whoever
    // happened to follow it.
    for (const listener of [...(this.listeners.get(frame.missionId) ?? [])]) {
      listener.frame(frame);
    }
  }

  latest(missionId: string): LiveFrame | null {
    return this.frames.get(missionId) ?? null;
  }

  /** Watch a mission. Returns the function that stops watching. */
  listen(missionId: string, listener: FrameListener): () => void {
    const existing = this.listeners.get(missionId);
    if (existing) existing.add(listener);
    else this.listeners.set(missionId, new Set([listener]));

    return () => {
      const current = this.listeners.get(missionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(missionId);
    };
  }

  /**
   * Forget a mission's frame and close everyone reading it.
   *
   * Called when the mission reaches a terminal state, when the agent link drops,
   * and by the staleness sweep. Ending the listeners is half the job: a response
   * left open on a mission that will never produce another frame is a socket held
   * for nothing and a customer watching a still image of a finished mission.
   */
  release(missionId: string): void {
    this.frames.delete(missionId);
    const listeners = this.listeners.get(missionId);
    if (!listeners) return;

    this.listeners.delete(missionId);
    for (const listener of [...listeners]) listener.end();
  }

  /** Release every mission belonging to one observatory. */
  releaseObservatory(observatoryId: string): number {
    let released = 0;
    for (const [missionId, frame] of [...this.frames]) {
      if (frame.observatoryId !== observatoryId) continue;
      this.release(missionId);
      released += 1;
    }
    return released;
  }

  /** Release every mission whose newest frame has aged out. */
  releaseStale(at: number, maxAgeMs = LIVE_FRAME_MAX_AGE_SECONDS * 1000): number {
    let released = 0;
    for (const [missionId, frame] of [...this.frames]) {
      if (at - frame.receivedAt <= maxAgeMs) continue;
      this.release(missionId);
      released += 1;
    }
    return released;
  }

  get size(): number {
    return this.frames.size;
  }
}
