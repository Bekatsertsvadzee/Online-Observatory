import { zGetMissionPath } from "@darkview/contracts/zod";

import { getMyMission } from "@/features/missions/mine";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /missions/{missionId} -- one mission the caller owns.
 *
 * Somebody else's mission and a malformed id both answer 404, identically to one
 * that does not exist.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const path = zGetMissionPath.safeParse(await context.params);
  const mission = path.success
    ? await getMyMission({ userId: guard.session.user.id, missionId: path.data.missionId })
    : null;
  if (!mission) return apiError(404, "NOT_FOUND", "No such mission.");

  return Response.json(mission);
}
