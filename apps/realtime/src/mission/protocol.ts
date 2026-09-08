import { randomUUID } from "node:crypto";

import type {
  AgentStateDelta,
  AgentCommandAck,
  Capture,
  ErrorCode,
  LiveFrameEncoding,
  MissionCaptureReady,
  MissionChannelError,
  MissionChannelMessage,
  MissionClientMessage,
  MissionCommandResult,
  MissionFailureReason,
  MissionState,
  MissionStateUpdate,
  MissionStreamInfo,
  MissionTelemetryUpdate,
  ObservatoryMode,
} from "@darkview/contracts";
import { zMissionClientMessage } from "@darkview/contracts/zod";

/**
 * How long a silent client stays subscribed.
 *
 * Far longer than the agent's grace period, and for the opposite reason. A silent
 * agent means a telescope nobody is watching, so the cloud reacts in fifteen
 * seconds. A silent client means a laptop lid closed on a browser tab, which
 * costs nothing but a socket -- so it is swept for tidiness, not for safety, and
 * a customer who tabs away for a minute does not lose their view.
 */
export const CLIENT_IDLE_GRACE_SECONDS = 120;

export type ParsedClientMessage =
  { ok: true; message: MissionClientMessage } | { ok: false; reason: string };

/**
 * Parse one inbound client frame against the generated contract schema.
 *
 * Never throws, for the same reason the agent's parser does not: a malformed
 * frame is routine, and one customer's broken tab must not take down the fan-out
 * every other subscriber on the mission is reading.
 */
export function parseClientMessage(raw: string): ParsedClientMessage {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }

  const result = zMissionClientMessage.safeParse(candidate);
  if (!result.success) {
    return { ok: false, reason: result.error.issues[0]?.message ?? "schema mismatch" };
  }

  return { ok: true, message: result.data as MissionClientMessage };
}

function messageHeader() {
  return { messageId: randomUUID(), sentAt: new Date().toISOString() };
}

export function missionStateUpdate(input: {
  missionId: string;
  state: MissionState;
  failureReason: MissionFailureReason | null;
}): MissionStateUpdate {
  return {
    type: "MISSION_STATE",
    ...messageHeader(),
    missionId: input.missionId,
    state: input.state,
    failureReason: input.failureReason,
    // Not computed here. The honest remaining time is the end of the booked slot
    // minus now, which is the orchestrator's arithmetic and belongs with the
    // booking -- and this service holds no business rules (architecture section 2).
    // Null reads as "unknown", which is true, where a guess would read as a promise.
    remainingSeconds: null,
  };
}

/**
 * Reduce operator-grade telemetry to what a customer may see.
 *
 * This is a deliberate narrowing, not a mapping that happens to drop fields. The
 * contract calls MissionTelemetryUpdate "deliberately narrower than
 * ObservatoryTelemetry: no device identity, no driver state, no address", so the
 * mount, camera and focuser DeviceStatus objects, the pointing coordinates, the
 * focuser position and the agent version all stop here. Adding a field to this
 * function is a contract change, not an implementation detail.
 */
export function missionTelemetryUpdate(
  missionId: string,
  delta: AgentStateDelta,
): MissionTelemetryUpdate {
  return {
    type: "MISSION_TELEMETRY",
    ...messageHeader(),
    missionId,
    // The mode a frame or a mission was produced under. Carried through so the UI
    // can say SIMULATED; a UI that cannot tell would be presenting simulator
    // output as real telescope output.
    mode: delta.telemetry.mode,
    link: delta.telemetry.link,
    tracking: delta.telemetry.tracking ?? null,
    centeringIteration: delta.centeringIteration ?? null,
    residualArcminutes: delta.residualArcminutes ?? null,
    // AgentStateDelta does not carry it. Stated as unknown rather than defaulted
    // to zero, which would tell the customer no nudge budget had been spent.
    nudgeUsedDegrees: null,
    ambientTemperatureC: delta.telemetry.ambientTemperatureC ?? null,
  };
}

/**
 * The agent's verdict on a command, on its way back to the client that caused it.
 *
 * The command was submitted over HTTP and answered there with "minted", which is
 * not the same as "done". This is where the customer learns that the telescope
 * refused -- including a REJECTED carrying a SAFETY_ reason after the cloud had
 * approved it, which is the two-validation design working and must be visible.
 */
export function missionCommandResult(
  missionId: string,
  ack: AgentCommandAck,
): MissionCommandResult {
  return {
    type: "MISSION_COMMAND_RESULT",
    ...messageHeader(),
    missionId,
    commandId: ack.commandId,
    status: ack.status,
    rejectionReason: ack.rejectionReason ?? null,
  };
}

/**
 * Where this customer reads the live view.
 *
 * A URL, never a device address. The observatory accepts no inbound connection
 * from the internet or the LAN, and nothing in this message gives anybody an
 * address for the mount, the camera or the mini-PC -- the client addresses the
 * cloud, which addresses nothing.
 *
 * `mode` is carried through from the frame that arrived, so a UI can say
 * SIMULATED. A client that cannot tell would be presenting simulator output as
 * telescope output.
 */
export function missionStreamInfo(
  missionId: string,
  offer: {
    streamUrl: string;
    expiresAt: Date;
    encoding: LiveFrameEncoding;
    mode: ObservatoryMode;
  },
): MissionStreamInfo {
  return {
    type: "MISSION_STREAM",
    ...messageHeader(),
    missionId,
    streamUrl: offer.streamUrl,
    encoding: offer.encoding,
    mode: offer.mode,
    expiresAt: offer.expiresAt.toISOString(),
  };
}

/**
 * A capture is in the customer's Collection.
 *
 * Sent once, when the row is written. A re-sent capture from the agent produces
 * no second message: the customer already has the image, and telling them twice
 * would put a duplicate in front of them that does not exist in their Collection.
 *
 * The whole Capture travels, not just its id, so the client can show the new
 * image without a round trip. `thumbnailUrl` is null here and must be -- it is a
 * signed URL minted against a caller, and this is a push.
 */
export function missionCaptureReady(capture: Capture): MissionCaptureReady {
  return {
    type: "MISSION_CAPTURE_READY",
    ...messageHeader(),
    missionId: capture.missionId,
    capture,
  };
}

export function missionChannelError(
  code: ErrorCode,
  message: string,
): MissionChannelError {
  return { type: "MISSION_ERROR", ...messageHeader(), code, message };
}

export type SendToClient = (message: MissionChannelMessage) => void;
export type CloseClient = (reason: string) => void;
