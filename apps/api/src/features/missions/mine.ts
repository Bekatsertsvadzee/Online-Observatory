import "server-only";

import type { Mission, MissionPage } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";
import { readContractMission } from "@/features/missions/observers";

/**
 * The signed-in customer's missions: upcoming and past, newest first.
 *
 * Scoped by `userId` in the WHERE clause, as the Collection is, so another
 * customer's mission is never fetched and cannot leak through a page edge. A
 * mission the customer only observed is not theirs and is not listed: observing
 * is presence, and ADR-007 gives an observer nothing to keep.
 */
export async function listMyMissions(input: {
  userId: string;
  cursor?: string;
  limit: number;
}): Promise<MissionPage> {
  const { userId, cursor, limit } = input;

  const rows = await getDatabase().mission.findMany({
    where: { userId },
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

/** One mission the caller owns, or null -- for one that is not theirs as well. */
export async function getMyMission(input: {
  userId: string;
  missionId: string;
}): Promise<Mission | null> {
  const database = getDatabase();
  const owned = await database.mission.findFirst({
    where: { id: input.missionId, userId: input.userId },
    select: { id: true },
  });
  return owned ? readContractMission(database, owned.id) : null;
}
