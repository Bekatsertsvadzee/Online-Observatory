import { zCaptureAssetKind, zCaptureId } from "@darkview/contracts/zod";

import { getCaptureDownload } from "@/features/captures/download";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /captures/{captureId}/download?kind=IMAGE -- a short-expiry signed URL.
 *
 * The contract: "Object storage buckets are never public. Every download is a
 * signed URL." Nothing here redirects to storage and nothing proxies the bytes;
 * the customer is handed a URL their browser fetches directly, which is the
 * whole point of ADR-012's bandwidth argument.
 *
 * Not metered by DV-115. It is a read of the caller's own object behind an
 * ownership check, and a customer retrying a failed download is the ordinary
 * case rather than the abusive one.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ captureId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const { captureId } = await context.params;
  if (!zCaptureId.safeParse(captureId).success) {
    return apiError(404, "NOT_FOUND", "No such capture.");
  }

  // `kind` is required by the contract and has no default here. Guessing IMAGE
  // would answer a request for a FITS with something else.
  const kind = zCaptureAssetKind.safeParse(
    new URL(request.url).searchParams.get("kind"),
  );
  if (!kind.success) {
    return apiError(422, "VALIDATION_FAILED", "A capture asset kind is required.");
  }

  const result = await getCaptureDownload({
    userId: guard.session.user.id,
    captureId,
    kind: kind.data,
    now: new Date(),
  });

  if (!result.ok) return apiError(404, "NOT_FOUND", "No such capture.");

  return Response.json(result.download);
}
