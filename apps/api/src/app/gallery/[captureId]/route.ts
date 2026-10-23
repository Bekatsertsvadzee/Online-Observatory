import { zGetGalleryCapturePath } from "@darkview/contracts/zod";

import { getGalleryCapture } from "@/features/captures/gallery";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /gallery/{captureId} -- a published capture, no sign-in (clients ADR-065).
 * Private, deleted and unknown are one 404.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ captureId: string }> },
) {
  const path = zGetGalleryCapturePath.safeParse(await context.params);
  const capture = path.success
    ? await getGalleryCapture(path.data.captureId, new Date())
    : null;
  if (!capture) return apiError(404, "NOT_FOUND", "No such capture.");

  return Response.json(capture, { headers: { "cache-control": "no-store" } });
}
