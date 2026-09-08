import "server-only";

import type {
  AdminCancelMissionRequest,
  ErrorCode,
  Mission,
  MissionPage,
  MissionState,
} from "@darkview/contracts";
import { recordAuditEvent } from "@darkview/db/audit";

import { getDatabase } from "@/lib/db/client";
import { readContractMission } from "@/features/missions/observers";
import { LIVE_MISSION_STATES } from "@/features/missions/session";
import { notifyAgent } from "@/lib/observatory/relay";

export type AdminMissionFailure = {
  ok: false;
  status: 404 | 409;
  code: ErrorCode;
  message: string;
};

/**
 * Every mission, for operations and support.
 *
 * Unscoped by user, which is the whole point of an operator endpoint and the
 * reason the route guard is `requireOperator` rather than `requireApiSession`.
 * `admin-routes-guarded.test.ts` is what keeps that from being forgotten.
 *
 * Newest first and keyset-paged, for the reasons the audit log already records: an
 * operator opening this is asking "what is happening now", and an offset page over
 * a table being written to while they read it silently repeats rows.
 */
export async function listAllMissions(input: {
  state?: MissionState;
  cursor?: string;
  limit: number;
}): Promise<MissionPage> {
  const { state, cursor, limit } = input;
  const database = getDatabase();

  const rows = await database.mission.findMany({
    where: state ? { state } : {},
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      booking: { select: { id: true } },
      captures: { select: { id: true } },
      participants: { where: { status: "JOINED" }, select: { id: true } },
    },
  });

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    items: items.map(
      (row): Mission => ({
        id: row.id,
        userId: row.userId,
        bookingId: row.booking?.id ?? null,
        targetId: row.targetId,
        observatoryId: row.observatoryId,
        state: row.state,
        failureReason: row.failureReason,
        mode: row.mode,
        scheduledStartAt: row.scheduledFor?.toISOString() ?? null,
        requestedAt: row.requestedAt.toISOString(),
        startedAt: row.startedAt?.toISOString() ?? null,
        endedAt: row.completedAt?.toISOString() ?? null,
        captureIds: row.captures.map((capture) => capture.id),
        observable: row.joinPolicy === "OPEN",
        observerCapacity: row.observerCapacity,
        observerCount: row.participants.length,
      }),
    ),
    page: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
  };
}

export type CancelResult = { ok: true; mission: Mission } | AdminMissionFailure;

/**
 * Force-cancel a mission an operator has decided must end.
 *
 * The thing this actually unblocks is the observatory. `Mission_active_per_
 * observatory_unique` allows one live mission per observatory, so a mission stuck
 * in a live state holds the observatory shut against every later booking, and
 * there is deliberately no automatic timeout to clear it. This is the hand.
 *
 * Three things happen together, or none of them do:
 *
 * 1. The mission moves to CANCELLED with `OPERATOR_ABORT`.
 * 2. Every live session on it is revoked, and the agent is told -- because the
 *    agent holds session ownership in memory and would otherwise keep accepting
 *    commands for a mission the cloud considers over.
 * 3. The audit row, carrying the operator, the reason and the refund resolution.
 *
 * The refund itself is not done here and cannot be: DV-056 owns payment and there
 * is no provider. `resolution` is recorded as the operator's decision, which is
 * the durable half; acting on it is the payment path's job, and inventing a refund
 * here would write a fiction into the payment tables.
 */
export async function cancelMissionAsOperator(input: {
  missionId: string;
  request: AdminCancelMissionRequest;
  operatorId: string;
  now: Date;
}): Promise<CancelResult> {
  const { missionId, request, operatorId, now } = input;
  const database = getDatabase();

  return database.$transaction(async (tx) => {
    const mission = await tx.mission.findUnique({
      where: { id: missionId },
      select: { id: true, state: true, observatoryId: true, isDemo: true },
    });
    if (!mission) {
      return { ok: false, status: 404, code: "NOT_FOUND", message: "No such mission." };
    }

    // A mission that already finished is left exactly as it finished. Rewriting a
    // COMPLETE to CANCELLED would erase what actually happened, and an operator
    // cancelling something already over is asking for nothing.
    const { count } = await tx.mission.updateMany({
      where: { id: missionId, state: { notIn: ["COMPLETE", "CANCELLED", "FAILED"] } },
      data: {
        state: "CANCELLED",
        failureReason: "OPERATOR_ABORT",
        completedAt: now,
      },
    });
    if (count !== 1) {
      return {
        ok: false,
        status: 409,
        code: "CONFLICT",
        message: `Mission ${missionId} is already ${mission.state}.`,
      };
    }

    await tx.missionEvent.create({
      data: {
        missionId,
        state: "CANCELLED",
        failureReason: "OPERATOR_ABORT",
        // The operator did this, not the agent. Filing it as AGENT would put an
        // instruction in the observatory's account of what it did.
        source: "OPERATOR",
        message: request.reason,
        occurredAt: now,
        simulated: false,
        isDemo: mission.isDemo,
      },
    });

    const revoked = await tx.missionSession.updateMany({
      where: { missionId, revokedAt: null },
      data: { revokedAt: now },
    });

    // Only when there was something to revoke. A null session update tells the
    // agent to stop accepting commands, which is right after a revocation and
    // noise otherwise.
    if (revoked.count > 0) {
      await notifyAgent(tx, {
        kind: "SESSION",
        observatoryId: mission.observatoryId,
        missionId,
        sessionId: null,
      });
    }

    await recordAuditEvent(
      {
        category: "MISSION",
        action: "OPERATOR_MISSION_CANCELLED",
        actorUserId: operatorId,
        missionId,
        entityType: "Mission",
        entityId: missionId,
        detail: {
          from: mission.state,
          reason: request.reason,
          // The operator's decision about money, recorded here because it is made
          // here. Acting on it is DV-056's, and there is no provider yet.
          resolution: request.resolution,
          sessionsRevoked: revoked.count,
          wasLive: LIVE_MISSION_STATES.includes(
            mission.state as (typeof LIVE_MISSION_STATES)[number],
          ),
        },
        isDemo: mission.isDemo,
      },
      tx,
    );

    return { ok: true, mission: await readContractMission(tx, missionId) };
  });
}
