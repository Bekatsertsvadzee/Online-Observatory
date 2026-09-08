import type { AgentCommandAck, AgentStateDelta, Capture } from "@darkview/contracts";

import type { MissionBroadcast } from "@/mission/broadcast";
import type { MissionSnapshot } from "@/mission/store";
import type { LiveFrame } from "@/stream/frames";

/**
 * A recording MissionBroadcast for tests.
 *
 * Records rather than no-ops, deliberately. The agent link's tests use it as a
 * stand-in, and the same object is what lets them assert that an applied event
 * actually reached the fan-out -- which is the assertion that fails if the wiring
 * in `server.ts` is ever removed.
 */
export class RecordingBroadcast implements MissionBroadcast {
  readonly moved: MissionSnapshot[] = [];
  readonly telemetry: { missionId: string; delta: AgentStateDelta }[] = [];
  readonly answered: AgentCommandAck[] = [];
  readonly frames: LiveFrame[] = [];
  readonly captures: Capture[] = [];

  missionMoved(snapshot: MissionSnapshot): void {
    this.moved.push(snapshot);
  }

  telemetryReported(missionId: string, delta: AgentStateDelta): void {
    this.telemetry.push({ missionId, delta });
  }

  async commandAnswered(ack: AgentCommandAck): Promise<void> {
    this.answered.push(ack);
  }

  liveFrameArrived(frame: LiveFrame): void {
    this.frames.push(frame);
  }

  captureRecorded(capture: Capture): void {
    this.captures.push(capture);
  }
}
