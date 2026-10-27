import {
  zAdminScheduleTestMissionPath,
  zScheduleTestMissionRequest,
} from "@darkview/contracts/zod";

import { scheduleTestMission } from "@/features/admin/test-mission";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /admin/observatories/{observatoryId}/test-mission -- an operator's own mission
 * on the hardware test observatory, starting now (ADR-075).
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const path = zAdminScheduleTestMissionPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such observatory.");

  const parsed = zScheduleTestMissionRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return apiError(
      422,
      "VALIDATION_FAILED",
      "A target and a length in quarter hours from 15 to 240 minutes are required.",
    );
  }

  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "admin-test-mission",
    identity: guard.session.user.id,
    category: "MISSION",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const result = await scheduleTestMission({
    observatoryId: path.data.observatoryId,
    request: parsed.data,
    actorUserId: guard.session.user.id,
    now: new Date(),
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.testMission, { status: 201 });
}
