import type { AgentCommandAck, AgentStateDelta, Capture } from "@darkview/contracts";

import {
  TERMINAL_MISSION_STATES,
  type LinkStore,
  type MissionLiveContext,
  type SessionEndedRecord,
} from "@/link/store";
import { bookedSessionTelemetry } from "@/mission/booked-session";
import {
  missionCaptureReady,
  missionCommandResult,
  missionSessionEnded,
  missionStateUpdate,
  missionTelemetryUpdate,
  missionFrameInfo,
  type LiveFrameDetail,
} from "@/mission/protocol";
import type { MissionChannelRegistry } from "@/mission/registry";
import type { MissionSnapshot } from "@/mission/store";
import type { LiveFrame } from "@/stream/frames";
import type { LiveFrameSink } from "@/stream/live-stream";

/**
 * What the agent link may tell the watching customers.
 *
 * An interface rather than the registry itself, so `AgentLink` depends on named
 * events and not on the fan-out's shape. DV-103 changes that shape -- an
 * observer sees a mission it has no session for -- and this is the seam that keeps
 * the change on this side of the line.
 */
export interface MissionBroadcast {
  missionMoved(snapshot: MissionSnapshot): void;
  telemetryReported(missionId: string, delta: AgentStateDelta): Promise<void>;
  commandAnswered(ack: AgentCommandAck): Promise<void>;
  liveFrameArrived(frame: LiveFrame, detail: LiveFrameDetail): void;
  captureRecorded(capture: Capture): void;
  sessionEnded(record: SessionEndedRecord): void;
}

/**
 * How long one read of a mission's booked-session facts serves its telemetry.
 *
 * Telemetry arrives several times a second; the facts behind the dwell and the
 * cooldown change a few times a session, and each change that passes through this
 * service -- a verdict, a transition, a capture -- drops the cached read at once. The
 * one that does not is a CAPTURE minted by the API, which this bounds to a few
 * seconds of a stale "capture allowed".
 */
export const LIVE_CONTEXT_TTL_MS = 5_000;

/**
 * The live implementation: agent events out to whoever is subscribed.
 *
 * Every method is best-effort and returns nothing useful. A mission event has
 * already been written to the database by the time it reaches here, so a client
 * that is not listening -- tab closed, socket half-dead -- costs that client its
 * view and costs the mission nothing. Nothing about a telescope may depend on a
 * browser being connected.
 */
export class MissionRelay implements MissionBroadcast {
  constructor(
    private readonly store: LinkStore,
    private readonly registry: MissionChannelRegistry,
    /**
     * Where a live frame is kept and where it is released.
     *
     * Held by the relay rather than by `AgentLink` because it is the same thing
     * every other method here does: take something the agent said and put it in
     * front of the people watching. The link decides whether a frame is the
     * observatory's to send; this decides who sees it.
     */
    private readonly frames: LiveFrameSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private readonly contexts = new Map<
    string,
    { context: MissionLiveContext | null; loadedAt: number }
  >();

  missionMoved(snapshot: MissionSnapshot): void {
    this.contexts.delete(snapshot.missionId);
    this.registry.broadcast(snapshot.missionId, missionStateUpdate(snapshot));

    // A finished mission produces no more frames, so the last one it produced is
    // freed here rather than left for the staleness sweep. Releasing also closes
    // the open responses: a customer must not be left watching a still image of a
    // mission that ended, and a process running for months must not accumulate the
    // final frame of every mission it ever carried.
    if ((TERMINAL_MISSION_STATES as readonly string[]).includes(snapshot.state)) {
      this.frames.release(snapshot.missionId);
    }
  }

  /**
   * One frame, to everyone watching this mission.
   *
   * The frame is stored first and offered second, because the offer is only valid
   * once there is something at the URL to fetch -- `StreamOffers.offer` returns
   * null until a frame exists, so the order here is the difference between a
   * client being given a live view and being given nothing.
   *
   * Nothing is pushed down the WebSocket but the URL. The contract gives the
   * mission channel no binary clause while giving the agent link one, and putting
   * frame bandwidth through the same socket as mission state would leave one slow
   * reader's telemetry and command verdicts queued behind stale pictures.
   */
  liveFrameArrived(frame: LiveFrame, detail: LiveFrameDetail): void {
    this.frames.publish(frame);
    for (const channel of this.registry.subscribers(frame.missionId)) {
      channel.offerStream();
    }
    // After the offer, so a client learns what the frame is once it can fetch it.
    this.registry.broadcast(
      frame.missionId,
      missionFrameInfo(frame.missionId, frame.mode, detail),
    );
  }

  /**
   * One capture, to everyone watching the mission it came from.
   *
   * The fan-out is the mission's, so an observer sees the message. That is the
   * correct reading of ADR-007 rather than a leak of one: an observer watching a
   * session sees that a capture happened, exactly as they see the mount slew.
   * What they do not get is the capture -- no CaptureAccess row, nothing in their
   * Collection, and no download. The recorder is where that is enforced, and it
   * grants the mission's own user and nobody else.
   */
  captureRecorded(capture: Capture): void {
    this.contexts.delete(capture.missionId);
    this.registry.broadcast(capture.missionId, missionCaptureReady(capture));
  }

  /**
   * One telemetry sample, narrowed, with the booked session's fields (ADR-079).
   *
   * Nobody watching, nothing read: the facts are loaded only for a mission somebody
   * is subscribed to, and then at most once per LIVE_CONTEXT_TTL_MS.
   */
  async telemetryReported(missionId: string, delta: AgentStateDelta): Promise<void> {
    if (this.registry.subscribers(missionId).length === 0) return;

    const now = this.now();
    const context = await this.liveContext(missionId, now);
    const session = bookedSessionTelemetry(context, {
      imageHealth: delta.imageHealth ?? null,
      parked: delta.telemetry.parked === true,
      now,
    });
    this.registry.broadcast(missionId, missionTelemetryUpdate(missionId, delta, session));
  }

  /** The session is over: told once, by whoever ended it (ADR-079 §6). */
  sessionEnded(record: SessionEndedRecord): void {
    this.contexts.delete(record.missionId);
    this.registry.broadcast(record.missionId, missionSessionEnded(record));
  }

  private async liveContext(missionId: string, now: Date) {
    const cached = this.contexts.get(missionId);
    if (cached && now.getTime() - cached.loadedAt < LIVE_CONTEXT_TTL_MS) return cached.context;

    // Swept on every fresh read rather than on a timer: an entry for a mission that
    // stopped reporting is gone the next time any mission reports.
    for (const [id, entry] of this.contexts) {
      if (now.getTime() - entry.loadedAt >= LIVE_CONTEXT_TTL_MS) this.contexts.delete(id);
    }
    const context = await this.store.loadMissionLiveContext(missionId);
    this.contexts.set(missionId, { context, loadedAt: now.getTime() });
    return context;
  }

  /**
   * Route a command verdict to the mission that command belongs to.
   *
   * The mission is read from the command row the cloud minted, not from the ack's
   * own `missionId`. The field exists and is optional, but it is the agent's
   * account of where the command came from, and routing a fan-out on it would let
   * one buggy agent deliver a rejection into a stranger's session. The minted row
   * is the cloud's own record and cannot be wrong about which mission it was for.
   */
  async commandAnswered(ack: AgentCommandAck): Promise<void> {
    const command = await this.store.loadCommand(ack.commandId);
    if (!command) return;
    // A verdict can move the dwell lock (RETARGET) or end a capture's wait.
    this.contexts.delete(command.envelope.missionId);

    this.registry.broadcast(
      command.envelope.missionId,
      missionCommandResult(command.envelope.missionId, ack),
    );
  }
}
