import "server-only";

import type {
  MissionEvent,
  MissionEventPage,
  MissionEventSource,
  MissionFailureReason,
  MissionState,
} from "@darkview/contracts";

import { DEFAULT_PAGE_LIMIT } from "@/features/audit/logs";
import { getDatabase } from "@/lib/db/client";

/**
 * One mission's trail, oldest first.
 *
 * Ordered by `occurredAt`, which is the observatory's clock for an agent-sourced
 * event and is replayed unchanged after a reconnect. That is deliberately not
 * insert order: a queue drained after an outage arrives late, and filing those
 * events under the moment the cloud happened to receive them would be a fabricated
 * chronology of a real telescope.
 */
export type MissionEventsFailure = { ok: false; status: 404 };
export type MissionEventsResult =
  { ok: true; page: MissionEventPage } | MissionEventsFailure;

export function toContractMissionEvent(row: {
  id: string;
  missionId: string;
  occurredAt: Date;
  state: MissionState;
  failureReason: MissionFailureReason | null;
  source: MissionEventSource;
  commandId: string | null;
  message: string | null;
}): MissionEvent {
  return {
    id: row.id,
    missionId: row.missionId,
    at: row.occurredAt.toISOString(),
    state: row.state,
    failureReason: row.failureReason,
    source: row.source,
    commandId: row.commandId,
    detail: row.message,
  };
}

export async function listMissionEvents(input: {
  missionId: string;
  actor: { id: string; role: "USER" | "OPERATOR" };
  cursor?: string;
  limit?: number;
}): Promise<MissionEventsResult> {
  const { missionId, actor, cursor } = input;
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  const database = getDatabase();

  const mission = await database.mission.findUnique({
    where: { id: missionId },
    select: { userId: true },
  });

  // The same refusal the rest of the mission surface gives: existence is private,
  // so a stranger probing mission ids gets the 404 rather than a 403 that would
  // confirm the mission is real.
  if (!mission || (actor.role !== "OPERATOR" && mission.userId !== actor.id)) {
    return { ok: false, status: 404 };
  }

  const rows = await database.missionEvent.findMany({
    where: { missionId },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    ok: true,
    page: {
      items: items.map(toContractMissionEvent),
      page: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
    },
  };
}
