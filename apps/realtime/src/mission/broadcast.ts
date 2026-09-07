import type { AgentCommandAck, AgentStateDelta } from "@darkview/contracts";

import type { LinkStore } from "@/link/store";
import {
  missionCommandResult,
  missionStateUpdate,
  missionTelemetryUpdate,
} from "@/mission/protocol";
import type { MissionChannelRegistry } from "@/mission/registry";
import type { MissionSnapshot } from "@/mission/store";

/**
 * What the agent link may tell the watching customers.
 *
 * An interface rather than the registry itself, so `AgentLink` depends on three
 * named events and not on the fan-out's shape. DV-103 changes that shape -- an
 * observer sees a mission it has no session for -- and this is the seam that keeps
 * the change on this side of the line.
 */
export interface MissionBroadcast {
  missionMoved(snapshot: MissionSnapshot): void;
  telemetryReported(missionId: string, delta: AgentStateDelta): void;
  commandAnswered(ack: AgentCommandAck): Promise<void>;
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
  ) {}

  missionMoved(snapshot: MissionSnapshot): void {
    this.registry.broadcast(snapshot.missionId, missionStateUpdate(snapshot));
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
