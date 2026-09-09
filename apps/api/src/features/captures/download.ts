import "server-only";

import type { CaptureAssetKind, CaptureDownload } from "@darkview/contracts";
import { presignDownload } from "@darkview/storage/presign";

import { getDatabase } from "@/lib/db/client";
import { getStorage } from "@/lib/storage/configuration";

/**
 * A short-expiry signed URL for one asset of one capture the caller owns.
 *
 * ADR-012: "Downloads are presigned GET URLs minted by the API against the
 * requesting customer" -- after the same ownership check `GET /captures/{id}`
 * already applies. The bucket is private and there is no public path, so this is
 * the only way a customer reaches their own image.
 *
 * The URL is minted per request rather than stored. A stored URL would be a
 * credential in a table with an expiry nobody watches, and a shared one would
 * outlive the sharing.
 */
export type DownloadResult =
  | { ok: true; download: CaptureDownload }
  | { ok: false; status: 404 };

export async function getCaptureDownload(input: {
  userId: string;
  captureId: string;
  kind: CaptureAssetKind;
  now: Date;
}): Promise<DownloadResult> {
  // One query, scoped by userId in the WHERE clause. A capture belonging to
  // somebody else is not fetched rather than fetched and filtered, so it cannot
  // leak through a later mistake -- and "not yours" and "no such capture" are the
  // same answer, so ids cannot be probed.
  const asset = await getDatabase().captureAsset.findFirst({
    where: {
      kind: input.kind,
      capture: { id: input.captureId, userId: input.userId },
    },
    select: { storageKey: true },
  });

  // A capture that exists without the asked-for asset is a 404 for that asset and
  // not an error: `fitsAvailable` is false for most captures, and asking for a
  // FITS that was never written is an ordinary miss.
  if (!asset) return { ok: false, status: 404 };

  const { url, expiresAt } = await presignDownload(
    getStorage(),
    asset.storageKey,
    input.now,
  );

  return {
    ok: true,
    download: { kind: input.kind, url, expiresAt: expiresAt.toISOString() },
  };
}
