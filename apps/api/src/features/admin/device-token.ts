import "server-only";

import type {
  DeviceTokenChangeRequest,
  DeviceTokenIssued,
  ErrorCode,
} from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { cancelMissionAsOperator } from "@/features/admin/missions";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { createOpaqueToken, hashToken } from "@/lib/auth/crypto";
import { getDatabase } from "@/lib/db/client";
import { notifyAgent } from "@/lib/observatory/relay";

/**
 * A node's device token: issued, rotated and revoked by an operator (ADR-020).
 *
 * The token exists in plain form only in the value returned from issue and rotate.
 * What is stored is its SHA-256, which is exactly what the link service compares on
 * the handshake, and nothing written here -- audit detail included -- carries it.
 */

type Refusal = { ok: false; status: number; code: ErrorCode; message: string };
type ChangeInput = {
  nodeId: string;
  request: DeviceTokenChangeRequest;
  operatorId: string;
  now: Date;
};

const noSuchNode: Refusal = {
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: "No such node.",
};

function findNode(nodeId: string) {
  return getDatabase().observatoryNetworkNode.findUnique({
    where: { id: nodeId },
    select: { id: true, observatoryId: true },
  });
}

/**
 * Write a token where the node's current state allows it.
 *
 * The condition is in the UPDATE rather than read first, so two operators issuing
 * at once cannot both succeed and leave the owner holding a token that was
 * replaced a moment later.
 */
async function writeToken(
  input: ChangeInput,
  mode: "ISSUE" | "ROTATE",
): Promise<{ ok: true; issued: DeviceTokenIssued } | Refusal> {
  const node = await findNode(input.nodeId);
  if (!node) return noSuchNode;

  const token = createOpaqueToken();

  const written = await getDatabase().$transaction(async (tx) => {
    const { count } = await tx.observatory.updateMany({
      where: {
        id: node.observatoryId,
        deviceTokenHash: mode === "ISSUE" ? null : { not: null },
      },
      data: { deviceTokenHash: hashToken(token) },
    });
    if (count === 0) return false;

    await recordAuditEvent(
      {
        category: "OBSERVATORY_MODE",
        action:
          mode === "ISSUE"
            ? "NETWORK_NODE_DEVICE_TOKEN_ISSUED"
            : "NETWORK_NODE_DEVICE_TOKEN_ROTATED",
        actorUserId: input.operatorId,
        entityType: "ObservatoryNetworkNode",
        entityId: node.id,
        detail: { observatoryId: node.observatoryId, reason: input.request.reason },
      },
      tx,
    );

    // An agent still connected with the old token is closed. Nothing is
    // connected with a token that did not exist, so issuing rings no bell.
    if (mode === "ROTATE") {
      await notifyAgent(tx, { kind: "CREDENTIAL", observatoryId: node.observatoryId });
    }
    return true;
  });

  if (!written) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message:
        mode === "ISSUE"
          ? "This node already has a device token. Rotate it to replace it."
          : "This node has no device token to rotate. Issue one first.",
    };
  }

  return {
    ok: true,
    issued: {
      nodeId: node.id,
      observatoryId: node.observatoryId,
      deviceToken: token,
      issuedAt: input.now.toISOString(),
    },
  };
}

export function issueDeviceToken(input: ChangeInput) {
  return writeToken(input, "ISSUE");
}

export function rotateDeviceToken(input: ChangeInput) {
  return writeToken(input, "ROTATE");
}

/**
 * Take the token away, and with it the link.
 *
 * Never refused once the node exists: a node with no token revokes without
 * complaint, the same rule suspension follows. A live mission is cancelled after
 * the token is gone, in the order suspension uses -- refusing first, unwinding
 * second -- so a failed cancel leaves a node nobody can connect to rather than one
 * that still accepts its agent.
 */
export async function revokeDeviceToken(
  input: ChangeInput,
): Promise<{ ok: true } | Refusal> {
  const node = await findNode(input.nodeId);
  if (!node) return noSuchNode;

  const database = getDatabase();
  const live = await database.mission.findFirst({
    where: { observatoryId: node.observatoryId, state: { in: [...LIVE_MISSION_STATES] } },
    select: { id: true },
  });

  await database.$transaction(async (tx) => {
    const previous = await tx.observatory.findUniqueOrThrow({
      where: { id: node.observatoryId },
      select: { deviceTokenHash: true },
    });
    await tx.observatory.update({
      where: { id: node.observatoryId },
      data: { deviceTokenHash: null },
    });

    await recordAuditEvent(
      {
        category: "OBSERVATORY_MODE",
        action: "NETWORK_NODE_DEVICE_TOKEN_REVOKED",
        actorUserId: input.operatorId,
        entityType: "ObservatoryNetworkNode",
        entityId: node.id,
        missionId: live?.id ?? null,
        detail: {
          observatoryId: node.observatoryId,
          reason: input.request.reason,
          wasIssued: previous.deviceTokenHash !== null,
          cancelledLiveMission: live !== null,
        },
      },
      tx,
    );

    await notifyAgent(tx, { kind: "CREDENTIAL", observatoryId: node.observatoryId });
  });

  if (live) {
    await cancelMissionAsOperator({
      missionId: live.id,
      request: {
        reason: `Device token revoked: ${input.request.reason}`,
        // As with suspension: revoking says nothing about money, so the refund
        // question is recorded as open rather than answered here.
        resolution: "NONE",
      },
      operatorId: input.operatorId,
      now: input.now,
    });
  }

  return { ok: true };
}
