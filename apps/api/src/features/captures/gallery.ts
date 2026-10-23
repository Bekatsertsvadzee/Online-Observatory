import "server-only";

import type { GalleryCapture } from "@darkview/contracts";
import { presignDownload } from "@darkview/storage/presign";

import { getDatabase } from "@/lib/db/client";
import { getStorage } from "@/lib/storage/configuration";

/**
 * A capture its owner published, for anyone with the link (clients ADR-065).
 *
 * Null for everything that is not a REAL capture set to GALLERY with an image, and the
 * route answers every null the same 404: a private capture, a deleted one and an id
 * that never existed must not be told apart. REAL is checked here as well as when the
 * flag is set, so a row that reached GALLERY some other way is still not shown.
 *
 * The owner, the mission, the booking and the price are never selected, so they cannot
 * leak through a later change to the mapping.
 */
export async function getGalleryCapture(
  captureId: string,
  now: Date,
): Promise<GalleryCapture | null> {
  const row = await getDatabase().capture.findFirst({
    where: { id: captureId, visibility: "GALLERY", mode: "REAL" },
    select: {
      id: true,
      capturedAt: true,
      imagingProfile: true,
      exposureMilliseconds: true,
      gain: true,
      framesStacked: true,
      integrationSeconds: true,
      widthPx: true,
      heightPx: true,
      mode: true,
      target: { select: { slug: true, nameEn: true, nameKa: true, type: true } },
      observatory: { select: { city: true, countryCode: true, timezone: true } },
      telescope: { select: { apertureMm: true, focalLengthMm: true } },
      assets: { where: { kind: "IMAGE" }, select: { storageKey: true }, take: 1 },
    },
  });
  const image = row?.assets.at(0);
  if (!row || !image) return null;

  const { url, expiresAt } = await presignDownload(getStorage(), image.storageKey, now);

  return {
    id: row.id,
    target: row.target,
    place: row.observatory,
    telescope: row.telescope,
    capturedAt: row.capturedAt.toISOString(),
    imagingProfile: row.imagingProfile,
    exposureMilliseconds: row.exposureMilliseconds,
    gain: row.gain,
    framesStacked: row.framesStacked,
    integrationSeconds: row.integrationSeconds,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    imageUrl: url,
    imageExpiresAt: expiresAt.toISOString(),
    mode: row.mode,
  };
}
