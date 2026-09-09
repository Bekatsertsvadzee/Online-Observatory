import { randomUUID } from "node:crypto";

import type {
  AgentToCloudMessage,
  CaptureAssetKind,
  CloudCommand,
  CloudError,
  CloudSafetyEnvelopeUpdate,
  CloudSessionUpdate,
  CloudToAgentMessage,
  CloudUploadGrant,
  CloudWelcome,
  CommandEnvelope,
  ErrorCode,
  SafetyEnvelopeConfig,
} from "@darkview/contracts";
import { zAgentToCloudMessage } from "@darkview/contracts/zod";

/**
 * The one protocol version this service speaks. An agent offering anything else
 * is refused at hello rather than tolerated: a half-understood message set on a
 * link that drives a telescope is worse than no link at all.
 */
export const PROTOCOL_VERSION = "1";

export const HEARTBEAT_INTERVAL_SECONDS = 5;

/**
 * How long a silent agent stays connected. Three missed heartbeats: one lost
 * heartbeat is a dropped packet, three is a link that is gone.
 *
 * This is the cloud's view. The agent runs its own, shorter, independent timer
 * and Parks without waiting to be told -- see the agent's watchdog. Neither side
 * relies on the other noticing.
 */
export const HEARTBEAT_GRACE_SECONDS = HEARTBEAT_INTERVAL_SECONDS * 3;

export type ParsedMessage =
  { ok: true; message: AgentToCloudMessage } | { ok: false; reason: string };

/**
 * Parse and validate one inbound frame against the generated contract schema.
 *
 * Never throws. A malformed frame is a routine event -- a truncated send, a bug
 * in a future agent build -- and the service answers it with CLOUD_ERROR and
 * keeps serving every other observatory.
 */
export function parseAgentMessage(raw: string): ParsedMessage {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }

  const result = zAgentToCloudMessage.safeParse(candidate);
  if (!result.success) {
    return { ok: false, reason: result.error.issues[0]?.message ?? "schema mismatch" };
  }

  return { ok: true, message: result.data as AgentToCloudMessage };
}

/** The messageId and sentAt every cloud-to-agent message carries. */
function messageHeader() {
  return { messageId: randomUUID(), sentAt: new Date().toISOString() };
}

export function cloudWelcome(expectedMissionId: string | null): CloudWelcome {
  return {
    type: "CLOUD_WELCOME",
    ...messageHeader(),
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    expectedMissionId,
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
  };
}

export function cloudError(code: ErrorCode, message: string, fatal = false): CloudError {
  return { type: "CLOUD_ERROR", ...messageHeader(), code, message, fatal };
}

/**
 * Wrap an envelope the orchestrator minted. Nothing is added to it and nothing is
 * rewritten: this service transports, it does not decide (architecture §2), and an
 * envelope altered in transit would not be the one the audit row records.
 */
export function cloudCommand(command: CommandEnvelope): CloudCommand {
  return { type: "CLOUD_COMMAND", ...messageHeader(), command };
}

/**
 * Permission to write exactly one object, for a few minutes (ADR-012).
 *
 * This is the whole of the observatory's authority over object storage. It holds
 * no bucket credential, so a stolen mini-PC yields a revocable device token and
 * nothing that could read or overwrite another customer's images.
 *
 * `storageKey` is echoed so the agent knows what it wrote and can report it back
 * on `AGENT_CAPTURE_READY`. It is the cloud's derived key -- the agent never
 * proposes one, which is what lets `CaptureAsset.storageKey` be trusted.
 */
export function cloudUploadGrant(grant: {
  missionId: string;
  commandId: string;
  kind: CaptureAssetKind;
  storageKey: string;
  url: string;
  expiresAt: Date;
}): CloudUploadGrant {
  return {
    type: "CLOUD_UPLOAD_GRANT",
    ...messageHeader(),
    missionId: grant.missionId,
    commandId: grant.commandId,
    kind: grant.kind,
    storageKey: grant.storageKey,
    url: grant.url,
    method: "PUT",
    expiresAt: grant.expiresAt.toISOString(),
  };
}

/**
 * Tell the agent who owns the mission. A null sessionId revokes it, after which
 * the agent accepts no client-originated command for that mission at all.
 *
 * `userId` is not optional in practice. The agent refuses any command whose
 * userId does not match the session owner, so an update without one leaves it
 * holding half an owner -- and the agent's answer to that, correctly, is to hold
 * no owner and refuse everything.
 */
export function cloudSessionUpdate(
  missionId: string,
  session: { sessionId: string; userId: string; expiresAt: Date } | null,
): CloudSessionUpdate {
  return {
    type: "CLOUD_SESSION_UPDATE",
    ...messageHeader(),
    missionId,
    sessionId: session?.sessionId ?? null,
    userId: session?.userId ?? null,
    expiresAt: session?.expiresAt.toISOString() ?? null,
  };
}

/**
 * Hand the agent the stored safety envelope.
 *
 * The agent keeps enforcing its own copy after this link dies, so this is not
 * advice -- it is the numbers a telescope will still be obeying when nothing is
 * left to correct them. An envelope whose `maxAltitudeDegrees` is null puts the
 * agent into the refuse-all-slews state, which is the correct reading of "nobody
 * has measured where this optical train collides with the mount yet".
 */
export function cloudSafetyEnvelopeUpdate(
  envelope: SafetyEnvelopeConfig,
): CloudSafetyEnvelopeUpdate {
  return { type: "CLOUD_SAFETY_ENVELOPE_UPDATE", ...messageHeader(), envelope };
}

export type Send = (message: CloudToAgentMessage) => void;
export type Close = (reason: string) => void;
