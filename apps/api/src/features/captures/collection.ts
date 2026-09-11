import "server-only";

import type { Capture, CapturePage } from "@darkview/contracts";
import { CAPTURE_CONTRACT_COLUMNS, toContractCapture } from "@darkview/db/capture";
import { presignDownload } from "@darkview/storage/presign";

import { getDatabase } from "@/lib/db/client";
import { getStorage } from "@/lib/storage/configuration";

// The contract's Limit parameter -- minimum 1, maximum 100, default 20 -- has one
// definition, and this is where the mission events route already reaches for it.
// A third copy of the same three lines is how two endpoints come to disagree about
// what `limit=0` means.
export { pageLimitOf } from "@/features/audit/logs";

/**
 * The columns a contract Capture needs, plus the one asset its thumbnail is.
 *
 * `take: 1` because `CaptureAsset_captureId_kind_key` allows one THUMBNAIL per
 * capture; the limit says so rather than trusting the index to be there.
 */
const CAPTURE_WITH_THUMBNAIL = {
  ...CAPTURE_CONTRACT_COLUMNS,
  assets: {
    where: { kind: "THUMBNAIL" as const },
    select: { storageKey: true },
    take: 1,
  },
};

type CaptureWithThumbnail = Parameters<typeof toContractCapture>[0] & {
  assets: { storageKey: string }[];
};

/**
 * A contract Capture, with its thumbnail signed for this caller (DV-065).
 *
 * The same presigned GET `GET /captures/{id}/download` mints, for the same reason:
 * the bucket is private and a signed URL is the only way a customer reaches their
 * own object. Minted per request against the caller, never stored -- a stored URL
 * is a credential in a table with an expiry nobody watches.
 *
 * Null when no THUMBNAIL was written, which is the contract's own word for "no
 * thumbnail". A capture from an agent that predates DV-065 has none, and a
 * fabricated path would be a broken image in every card.
 *
 * Signing is arithmetic, not a request: nothing leaves this process, so a page of
 * a hundred captures costs a hundred HMACs and no round trips.
 */
async function withSignedThumbnail(
  row: CaptureWithThumbnail,
  now: Date,
): Promise<Capture> {
  const thumbnail = row.assets.at(0);
  if (!thumbnail) return toContractCapture(row);

  const { url } = await presignDownload(getStorage(), thumbnail.storageKey, now);
  return toContractCapture(row, url);
}

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
  now: Date;
}): Promise<CapturePage> {
  const { userId, cursor, limit, now } = input;

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
    select: CAPTURE_WITH_THUMBNAIL,
  });

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return {
    items: await Promise.all(items.map((row) => withSignedThumbnail(row, now))),
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
  now: Date;
}): Promise<Capture | null> {
  const row = await getDatabase().capture.findFirst({
    where: { id: input.captureId, userId: input.userId },
    select: CAPTURE_WITH_THUMBNAIL,
  });

  return row ? withSignedThumbnail(row, input.now) : null;
}
