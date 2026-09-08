import { zAdminCancelMissionRequest, zMissionId } from "@darkview/contracts/zod";

import { cancelMissionAsOperator } from "@/features/admin/missions";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /admin/missions/{missionId}/cancel -- end a mission by hand.
 *
 * The thing this unblocks is the observatory: one live mission per observatory is
 * a database rule, there is deliberately no automatic timeout, and a mission stuck
 * in a live state refuses every later booking until somebody ends it.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  const parsed = zAdminCancelMissionRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return apiError(422, "VALIDATION_FAILED", "A reason and a refund resolution are required.");
  }

  const result = await cancelMissionAsOperator({
    missionId,
    request: parsed.data,
    operatorId: guard.session.user.id,
    now: new Date(),
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.mission);
}
