import "server-only";

import type {
  ApproveNetworkNodeRequest,
  ErrorCode,
  NetworkNode,
  SuspendNetworkNodeRequest,
} from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { cancelMissionAsOperator } from "@/features/admin/missions";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { toContractNode } from "@/features/network/nodes";
import { getDatabase } from "@/lib/db/client";

/**
 * Qualifying a partner observatory, and un-qualifying it (ADR-013).
 *
 * This is the whole of the path out of `DRAFT`. Everything else about a partner
 * node refuses by default; approval is the single deliberate act that lets a
 * telescope somebody else owns be operated by somebody neither of them has met,
 * while nobody is standing next to it.
 *
 * It is an operator action and is audited as one, with the operator's identity
 * and their reason recorded verbatim.
 */

const NODE_COLUMNS = {
  id: true,
  observatoryId: true,
  ownerId: true,
  kind: true,
  approvalStatus: true,
  capabilities: true,
  approvedAt: true,
  createdAt: true,
  observatory: {
    select: {
      nameEn: true,
      city: true,
      countryCode: true,
      timezone: true,
      safetyEnvelope: { select: { maxAltitudeDegrees: true } },
    },
  },
} as const;

export type NetworkNodeFailure = {
  ok: false;
  status: 404 | 409 | 422;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type NetworkNodeResult = { ok: true; node: NetworkNode } | NetworkNodeFailure;

/**
 * The five conditions only a person can attest, in the order ADR-013 lists them.
 *
 * Separate fields rather than one confirmation, because they are separate things
 * somebody had to go and do. A single "I confirm everything" is a box that gets
 * ticked without reading, and the whole point of the record is that a person went
 * and looked at a telescope.
 */
const ATTESTED_CONDITIONS = [
  "coordinatesVerified",
  "horizonMaskRecorded",
  "firstLightSupervised",
  "parkProven",
  "ownerTermsAccepted",
] as const;

/**
 * Qualify a node to operate unattended.
 *
 * Two kinds of condition, checked differently on purpose.
 *
 * The five above are attested: no query can tell whether a person watched a park
 * or read a horizon. They are recorded verbatim in the audit row, so an approval
 * is a statement somebody made and can be held to.
 *
 * The sixth -- a **measured** safety envelope for that instrument -- is checked
 * here against the database rather than asserted, because the database knows the
 * answer. `MAX_ALT_SAFE` is where the optical train meets the mount, and a
 * checkbox for it would let an unmeasured telescope be approved by clicking. It
 * stays measured, never guessed, never defaulted, on a partner's instrument
 * exactly as on Darkview's own.
 */
export async function approveNetworkNode(input: {
  nodeId: string;
  request: ApproveNetworkNodeRequest;
  operatorId: string;
  now: Date;
}): Promise<NetworkNodeResult> {
  const database = getDatabase();

  const node = await database.observatoryNetworkNode.findUnique({
    where: { id: input.nodeId },
    select: NODE_COLUMNS,
  });

  if (!node) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such node." };
  }

  // Only from UNDER_REVIEW. Approving straight out of DRAFT would skip the step
  // where the owner says the telescope is actually set up, and approving an
  // already-approved node would move `approvedAt` without anything having been
  // re-checked.
  if (node.approvalStatus !== "UNDER_REVIEW") {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `A node in ${node.approvalStatus} is not awaiting approval.`,
    };
  }

  const unmet = ATTESTED_CONDITIONS.filter((condition) => !input.request[condition]);
  if (unmet.length > 0) {
    return {
      ok: false,
      status: 422,
      code: "VALIDATION_FAILED",
      message: "Every qualification condition must be attested before approval.",
      details: { unmet },
    };
  }

  if (node.observatory.safetyEnvelope?.maxAltitudeDegrees == null) {
    return {
      ok: false,
      status: 422,
      code: "SAFETY_NOT_CONFIGURED",
      message:
        "This instrument has no measured altitude limit. Measure it before approving; " +
        "it is not a value an operator may attest.",
    };
  }

  const approved = await database.$transaction(async (tx) => {
    const updated = await tx.observatoryNetworkNode.update({
      where: { id: node.id },
      data: { approvalStatus: "APPROVED", approvedAt: input.now },
      select: NODE_COLUMNS,
    });

    await recordAuditEvent(
      {
        category: "OBSERVATORY_MODE",
        action: "NETWORK_NODE_APPROVED",
        actorUserId: input.operatorId,
        entityType: "ObservatoryNetworkNode",
        entityId: node.id,
        detail: {
          observatoryId: node.observatoryId,
          ownerId: node.ownerId,
          // Verbatim, and each condition separately. An approval that recorded
          // only "approved" would say a decision was made and nothing about what
          // it was based on.
          reason: input.request.reason,
          coordinatesVerified: input.request.coordinatesVerified,
          horizonMaskRecorded: input.request.horizonMaskRecorded,
          firstLightSupervised: input.request.firstLightSupervised,
          parkProven: input.request.parkProven,
          ownerTermsAccepted: input.request.ownerTermsAccepted,
        },
      },
      tx,
    );

    return updated;
  });

  return { ok: true, node: toContractNode(approved) };
}

/**
 * Take a node's qualification away, immediately.
 *
 * `SUSPENDED`, not `DRAFT`. Both refuse everything, and they are different facts:
 * a node in DRAFT has never been qualified, one in SUSPENDED was and had it
 * revoked. ADR-013's prose says "returns to DRAFT" -- written before its author
 * noticed the schema already distinguished the two -- and the schema is right.
 *
 * The emergency stop for a telescope nobody is standing next to, and it follows
 * the rule the rest of this system follows: **anything that stops the telescope
 * is never refused.** An already-suspended node is suspended again without
 * complaint, and a live mission is a reason to suspend rather than a reason to
 * wait -- which is the opposite of how a mode switch behaves, deliberately,
 * because a mode switch starts something and this stops it.
 *
 * The running mission is ended through the operator cancel path rather than by
 * writing mission rows here. That path already parks the telescope, revokes the
 * session and tells the agent; a second implementation of it would be a second
 * chance to get stopping a telescope wrong.
 */
export async function suspendNetworkNode(input: {
  nodeId: string;
  request: SuspendNetworkNodeRequest;
  operatorId: string;
  now: Date;
}): Promise<NetworkNodeResult> {
  const database = getDatabase();

  const node = await database.observatoryNetworkNode.findUnique({
    where: { id: input.nodeId },
    select: { id: true, observatoryId: true, ownerId: true, approvalStatus: true },
  });

  if (!node) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: "No such node." };
  }

  const live = await database.mission.findFirst({
    where: {
      observatoryId: node.observatoryId,
      state: { in: [...LIVE_MISSION_STATES] },
    },
    select: { id: true },
  });

  // Suspend first, so that the node is refusing before the mission is unwound. If
  // the cancel below fails, a suspended node with a live mission is a state an
  // operator can see and act on; an approved node with a cancelled mission would
  // be one that quietly accepts the next customer.
  const suspended = await database.$transaction(async (tx) => {
    const updated = await tx.observatoryNetworkNode.update({
      where: { id: node.id },
      data: { approvalStatus: "SUSPENDED", approvedAt: null },
      select: NODE_COLUMNS,
    });

    await recordAuditEvent(
      {
        category: "OBSERVATORY_MODE",
        action: "NETWORK_NODE_SUSPENDED",
        actorUserId: input.operatorId,
        entityType: "ObservatoryNetworkNode",
        entityId: node.id,
        missionId: live?.id ?? null,
        detail: {
          observatoryId: node.observatoryId,
          previousStatus: node.approvalStatus,
          reason: input.request.reason,
          cancelledLiveMission: live !== null,
        },
      },
      tx,
    );

    return updated;
  });

  if (live) {
    await cancelMissionAsOperator({
      missionId: live.id,
      request: {
        reason: `Node suspended: ${input.request.reason}`,
        // The operator suspending a node has said nothing about money, and this
        // code must not decide it for them. NONE records that the refund question
        // is open rather than answering it wrongly.
        resolution: "NONE",
      },
      operatorId: input.operatorId,
      now: input.now,
    });
  }

  return { ok: true, node: toContractNode(suspended) };
}
