import type { AgentCommandAck, AgentStateDelta } from "@darkview/contracts";

import { TERMINAL_MISSION_STATES, type LinkStore } from "@/link/store";
import {
  missionCommandResult,
  missionStateUpdate,
  missionTelemetryUpdate,
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
  telemetryReported(missionId: string, delta: AgentStateDelta): void;
  commandAnswered(ack: AgentCommandAck): Promise<void>;
  liveFrameArrived(frame: LiveFrame): void;
}

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
  ) {}

  missionMoved(snapshot: MissionSnapshot): void {
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
  liveFrameArrived(frame: LiveFrame): void {
    this.frames.publish(frame);
    for (const channel of this.registry.subscribers(frame.missionId)) {
      channel.offerStream();
    }
  }

  telemetryReported(missionId: string, delta: AgentStateDelta): void {
    this.registry.broadcast(missionId, missionTelemetryUpdate(missionId, delta));
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

    this.registry.broadcast(
      command.envelope.missionId,
      missionCommandResult(command.envelope.missionId, ack),
    );
  }
}
