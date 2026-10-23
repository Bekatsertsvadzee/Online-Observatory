import { zMissionBroadcastSettings, zMissionId } from "@darkview/contracts/zod";

import { setMissionBroadcast } from "@/features/missions/broadcast";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, MISSION_SESSION_POLICY } from "@/lib/security/rate-limit";

/**
 * PATCH /missions/{missionId}/broadcast -- the owner opens the session to Tonight, live
 * (clients ADR-066), or closes it. Owner-only, operators refused like anyone else: the
 * thing granted is consent, and it is the owner's.
 */
export const dynamic = "force-dynamic";

export async function PATCH(
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
    scope: "mission-broadcast",
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

  const body = zMissionBroadcastSettings.safeParse(raw);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "MissionBroadcastSettings is malformed.", {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const result = await setMissionBroadcast({
    missionId,
    userId: guard.session.user.id,
    broadcast: body.data.broadcast,
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.value);
}
