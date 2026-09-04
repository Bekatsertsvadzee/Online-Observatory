import { zMissionId } from "@darkview/contracts/zod";

import { startMissionSession } from "@/features/missions/session";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /missions/{missionId}/start -- become the single active session owner.
 *
 * The session identity minted here is what every later CommandEnvelope carries,
 * and what the agent checks a command against. It is not a device credential and
 * grants no access to hardware: it says who is allowed to ask, not what may happen.
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  const result = await startMissionSession({
    missionId,
    actor: { id: guard.session.user.id, role: guard.session.user.role },
    now: new Date(),
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.session);
}
