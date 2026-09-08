import { zMissionId, zMissionObservationSettings } from "@darkview/contracts/zod";

import { setMissionObservation } from "@/features/missions/observers";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, MISSION_SESSION_POLICY } from "@/lib/security/rate-limit";

/**
 * PUT /missions/{missionId}/observation -- the controller's consent to be watched.
 *
 * ADR-007 rule 5, and the only way a session becomes observable. Owner-only, and
 * an operator is refused like anyone else: the thing being granted is consent,
 * and an operator is not the person whose consent it is.
 */
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  const limited = await meterRequest({
    policy: MISSION_SESSION_POLICY,
    scope: "mission-observation",
    identity: guard.session.user.id,
    category: "MISSION",
    actorUserId: guard.session.user.id,
    missionId,
  });
  if (limited) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zMissionObservationSettings.safeParse(raw);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "MissionObservationSettings is malformed.", {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const result = await setMissionObservation({
    missionId,
    actor: { id: guard.session.user.id, role: guard.session.user.role },
    observable: body.data.observable,
    now: new Date(),
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.value);
}
