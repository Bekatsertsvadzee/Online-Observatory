import "server-only";

import type { Capture, CapturePage } from "@darkview/contracts";
import { CAPTURE_CONTRACT_COLUMNS, toContractCapture } from "@darkview/db/capture";

import { getDatabase } from "@/lib/db/client";

// The contract's Limit parameter -- minimum 1, maximum 100, default 20 -- has one
// definition, and this is where the mission events route already reaches for it.
// A third copy of the same three lines is how two endpoints come to disagree about
// what `limit=0` means.
export { pageLimitOf } from "@/features/audit/logs";

/**
 * The Collection: what a customer keeps.
 *
 * `CLAUDE.md` describes the product as a customer who "can Capture the result, and
 * keeps it in their Collection", and the contract calls `GET /captures` "the
 * signed-in user's Collection". The Collection is therefore the captures they own
 * -- not the `Collection` table, which holds curated named sets (SOLAR_SYSTEM,
 * MESSIER_STARTER) that no endpoint reads and nothing yet writes.
 *
 * Ownership is the whole access model here. Every read is scoped by `userId` in
 * the WHERE clause rather than filtered after the fact, so a capture that is not
 * the caller's is not fetched, cannot be counted, and cannot leak through a
 * pagination edge.
 */

/**
 * One page of the caller's Collection, newest first.
 *
 * Newest first because a customer opening this has just finished a session and is
 * looking for the image they took twenty minutes ago, not the first one they ever
 * took.
 *
 * Ordered by `capturedAt`, which is the observatory's account of when the shutter
 * closed -- not `createdAt`, which is when the cloud heard about it. A capture the
 * agent queued through a network outage and delivered an hour later belongs where
 * it was taken in the customer's evening, not at the top of the list above images
 * from a later session.
 *
 * Keyset pagination, like the audit log, and for a sharper reason: this table is
 * written to while a customer is reading it -- a mission in progress is producing
 * captures -- and an offset page would silently repeat rows as new ones arrive.
 */
export async function listCaptures(input: {
  userId: string;
  cursor?: string;
  limit: number;
}): Promise<CapturePage> {
  const { userId, cursor, limit } = input;

  const rows = await getDatabase().capture.findMany({
    where: { userId },
    // The id is the tiebreak, not decoration. A stacked sequence can produce two
    // captures with the same capturedAt, and a keyset cursor over an order the
    // database is free to vary between requests skips rows.
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    // One more than asked for, so `hasMore` is an observation rather than a count
    // query that could disagree with the page beside it.
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: CAPTURE_CONTRACT_COLUMNS,
  });

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    // thumbnailUrl is null throughout. It is a signed, short-expiry URL and there
    // is nothing to sign against yet -- see the download route. Null is the
    // contract's own word for "no thumbnail", and a fabricated path would be a
    // broken image in every card.
    items: items.map((row) => toContractCapture(row)),
    page: { hasMore, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null },
  };
}

/**
 * One capture the caller owns, or nothing.
 *
 * Scoped by userId in the query, so a capture belonging to somebody else is
 * indistinguishable from one that does not exist. The route answers 404 for both,
 * which is the same rule `startMissionSession` follows: a customer probing ids
 * must not be able to tell "not yours" from "not a capture".
 *
 * An operator has no exception here, deliberately. `GET /captures/{id}` is the
 * customer's own Collection and the contract gives it no operator scope; operator
 * access to somebody's images would be a decision about privacy, not a widening of
 * a read, and DV-063 is where it would be argued.
 */
export async function getCapture(input: {
  userId: string;
  captureId: string;
}): Promise<Capture | null> {
  const row = await getDatabase().capture.findFirst({
    where: { id: input.captureId, userId: input.userId },
    select: CAPTURE_CONTRACT_COLUMNS,
  });

  return row ? toContractCapture(row) : null;
}
