import { zGetObservatoryStatusPath } from "@darkview/contracts/zod";

import { findBookableObservatory } from "@/features/booking/observatories";
import { readPublicObservatoryStatus } from "@/features/observatory/status";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /observatories/{observatoryId}/state -- the public status chip (ADR-019).
 *
 * Answered only for an observatory `GET /observatories` lists. An unknown id and a
 * node that is not bookable are one 404: whether a suspended partner exists is not
 * something a customer may learn by probing ids.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const path = zGetObservatoryStatusPath.safeParse(await context.params);
  const bookable = path.success ? await findBookableObservatory(path.data.observatoryId) : null;
  const status = bookable ? await readPublicObservatoryStatus(bookable.id) : null;
  if (!status) return apiError(404, "NOT_FOUND", "No such observatory.");

  return Response.json(status);
}
