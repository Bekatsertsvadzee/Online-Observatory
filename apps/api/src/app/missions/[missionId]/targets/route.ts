import { zListMissionTargetsPath } from "@darkview/contracts/zod";

import { listMissionTargets } from "@/features/missions/targets";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /missions/{missionId}/targets -- the objects a live session may switch to now
 * (ADR-079), best first.
 *
 * Owner only: somebody else's mission and a malformed id both answer 404, as
 * `GET /missions/{missionId}` does. Computed at request time.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const path = zListMissionTargetsPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such mission.");

  const result = await listMissionTargets({
    missionId: path.data.missionId,
    userId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.list);
}
