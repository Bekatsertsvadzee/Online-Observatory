import { zListTonightTargetsQuery } from "@darkview/contracts/zod";

import { listTonightTargets } from "@/features/targets/tonight";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /targets/tonight?observatoryId=... -- the catalogue filtered by live
 * ephemeris, at one observatory.
 *
 * Public: choosing what to look at does not require an account. Computed at
 * request time, never served from a static list, and never cached.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const observatoryId = params.get("observatoryId");
  const requested = params.get("at");

  // Required since DV-067. Visibility is a fact about a site, and defaulting to
  // one would be the findFirst this replaced.
  if (!zListTonightTargetsQuery.shape.observatoryId.safeParse(observatoryId).success) {
    return apiError(422, "VALIDATION_FAILED", "`observatoryId` must be a UUID.");
  }

  const at = requested ? new Date(requested) : new Date();

  if (Number.isNaN(at.getTime())) {
    return apiError(422, "VALIDATION_FAILED", "`at` must be an RFC 3339 timestamp.");
  }

  const list = await listTonightTargets(observatoryId as string, at);

  // Unknown and not bookable are one answer, as on GET /slots.
  if (!list) return apiError(404, "NOT_FOUND", "No such observatory.");

  return Response.json(list);
}
