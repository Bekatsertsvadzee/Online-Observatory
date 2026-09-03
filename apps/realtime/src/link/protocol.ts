import { randomUUID } from "node:crypto";

import type {
  AgentToCloudMessage,
  CloudError,
  CloudToAgentMessage,
  CloudWelcome,
  ErrorCode,
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
  | { ok: true; message: AgentToCloudMessage }
  | { ok: false; reason: string };

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

function envelope() {
  return { messageId: randomUUID(), sentAt: new Date().toISOString() };
}

export function cloudWelcome(expectedMissionId: string | null): CloudWelcome {
  return {
    type: "CLOUD_WELCOME",
    ...envelope(),
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    expectedMissionId,
    heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
  };
}

export function cloudError(
  code: ErrorCode,
  message: string,
  fatal = false,
): CloudError {
  return { type: "CLOUD_ERROR", ...envelope(), code, message, fatal };
}

export type Send = (message: CloudToAgentMessage) => void;
export type Close = (reason: string) => void;
