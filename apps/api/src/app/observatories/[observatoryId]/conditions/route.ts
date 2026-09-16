import { zGetObservatoryConditionsPath } from "@darkview/contracts/zod";

import { readViewingConditions } from "@/features/observatory/conditions";
import { apiError } from "@/lib/http/api-error";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * GET /observatories/{observatoryId}/conditions -- tonight's viewing forecast (DV-110).
 *
 * Public, and answered only for an observatory `GET /observatories` lists: an
 * unknown id and a node that is not bookable are one 404 (ADR-019). Advisory
 * only; the weather hold on `/state` stays authoritative.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const path = zGetObservatoryConditionsPath.safeParse(await context.params);
  const conditions = path.success
    ? await readViewingConditions(
        path.data.observatoryId,
        new Date(),
        getServerEnvironment().VIEWING_CONDITIONS_MAX_AGE_MINUTES,
      )
    : null;
  if (!conditions) return apiError(404, "NOT_FOUND", "No such observatory.");

  return Response.json(conditions);
}
