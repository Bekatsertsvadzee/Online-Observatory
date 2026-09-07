import { zMissionId } from "@darkview/contracts/zod";

import { pageLimitOf } from "@/features/audit/logs";
import { listMissionEvents } from "@/features/missions/events";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /missions/{missionId}/events -- one mission's correlated event log.
 *
 * The customer sees their own mission's trail; an operator sees any. A mission
 * that is not the caller's is a 404 rather than a 403, for the same reason the
 * rest of the mission surface answers that way.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  const query = new URL(request.url).searchParams;

  const result = await listMissionEvents({
    missionId,
    actor: { id: guard.session.user.id, role: guard.session.user.role },
    cursor: query.get("cursor") ?? undefined,
    limit: pageLimitOf(query.get("limit")),
  });

  if (!result.ok) return apiError(404, "NOT_FOUND", "No such mission.");

  return Response.json(result.page);
}
