import { zGetObservatoryUptimePath } from "@darkview/contracts/zod";

import { readObservatoryUptime } from "@/features/observatory/uptime";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /observatories/{observatoryId}/uptime -- thirty days of link uptime (Phase 6.0).
 *
 * Public, and answered only for an observatory `GET /observatories` lists: an
 * unknown id and a node that is not bookable are one 404 (ADR-019).
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const path = zGetObservatoryUptimePath.safeParse(await context.params);
  const uptime = path.success
    ? await readObservatoryUptime(path.data.observatoryId, new Date())
    : null;
  if (!uptime) return apiError(404, "NOT_FOUND", "No such observatory.");

  return Response.json(uptime);
}
