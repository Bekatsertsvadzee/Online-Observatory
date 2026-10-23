import { zGetObservatoryHorizonPath } from "@darkview/contracts/zod";

import { readObservatoryHorizon } from "@/features/observatory/horizon";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /observatories/{observatoryId}/horizon -- the horizon mask, for drawing the sky
 * (Phase 6.2). Public, and 404 for an observatory that is not bookable (ADR-019).
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const path = zGetObservatoryHorizonPath.safeParse(await context.params);
  const horizon = path.success
    ? await readObservatoryHorizon(path.data.observatoryId)
    : null;
  if (!horizon) return apiError(404, "NOT_FOUND", "No such observatory.");

  return Response.json(horizon);
}
