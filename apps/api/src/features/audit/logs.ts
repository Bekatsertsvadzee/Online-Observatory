import "server-only";

import type { AuditCategory, AuditEvent, AuditEventPage } from "@darkview/contracts";

import { getDatabase } from "@/lib/db/client";

/**
 * The correlated audit stream, newest first.
 *
 * Newest first because of what this is for: the contract calls it "the primary
 * debugging tool", and the question asked of it is always "what just happened".
 * The mission trail (`/missions/{id}/events`) is ordered the other way, because
 * that one is read as a story rather than as an incident feed.
 *
 * Pagination is keyset, not offset. An offset page over an append-only table that
 * is being written to while an operator reads it silently repeats rows; the cursor
 * is the id of the last row of the previous page and cannot.
 */

/** Contract: the Limit parameter -- minimum 1, maximum 100, default 20. */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export function pageLimitOf(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_PAGE_LIMIT);
}

/**
 * A stored row as the contract describes it.
 *
 * `actorHash` never crosses the boundary. It identifies a failed login attempt
 * without storing the address that made it, and AuditEvent does not declare it, so
 * it stays in the database.
 *
 * `entityType` and `entityId` are not AuditEvent fields either, but the operator
 * needs to know what a row is about. They go into `detail`, which the contract
 * declares as free-form -- rather than into invented top-level fields, which would
 * be a second definition of a type that crosses a process boundary.
 */
export function toContractAuditEvent(row: {
  id: string;
  createdAt: Date;
  category: AuditCategory;
  action: string;
  actorUserId: string | null;
  missionId: string | null;
  commandId: string | null;
  entityType: string | null;
  entityId: string | null;
  metadata: unknown;
}): AuditEvent {
  const stored =
    typeof row.metadata === "object" &&
    row.metadata !== null &&
    !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};

  const detail: Record<string, unknown> = { ...stored };
  if (row.entityType !== null) detail.entityType = row.entityType;
  if (row.entityId !== null) detail.entityId = row.entityId;

  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    category: row.category,
    action: row.action,
    actorUserId: row.actorUserId,
    missionId: row.missionId,
    commandId: row.commandId,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  };
}

export async function listAuditEvents(input: {
  missionId?: string;
  category?: AuditCategory;
  cursor?: string;
  limit: number;
}): Promise<AuditEventPage> {
  const { missionId, category, cursor, limit } = input;

  const rows = await getDatabase().auditLog.findMany({
    where: {
      ...(missionId ? { missionId } : {}),
      ...(category ? { category } : {}),
    },
    // The id is the tiebreak, not decoration: two rows written in the same
    // millisecond would otherwise page in an order the database is free to change
    // between requests, and a keyset cursor over an unstable order skips rows.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    // One more than asked for, so `hasMore` is an observation rather than a count
    // query that could disagree with the page beside it.
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    items: items.map(toContractAuditEvent),
    page: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
  };
}
