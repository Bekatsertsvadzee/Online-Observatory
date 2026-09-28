import { zMissionId } from "@darkview/contracts/zod";

import { getMissionWatchView } from "@/features/missions/watch";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /missions/{missionId}/watch -- one read of a session for those allowed to
 * watch it (ADR-034). Not allowed, not existing and a malformed id all answer the
 * same 404.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  const view = zMissionId.safeParse(missionId).success
    ? await getMissionWatchView({ missionId, actorId: guard.session.user.id })
    : null;
  if (!view) return apiError(404, "NOT_FOUND", "No such mission.");

  return Response.json(view);
}
