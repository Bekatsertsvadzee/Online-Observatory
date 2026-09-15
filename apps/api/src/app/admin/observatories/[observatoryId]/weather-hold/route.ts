import { zAdminSetWeatherHoldPath, zSetWeatherHoldRequest } from "@darkview/contracts/zod";

import {
  setWeatherHold,
  weatherHoldIsExemptFromMetering,
} from "@/features/admin/observatory";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /admin/observatories/{observatoryId}/weather-hold -- set or clear the
 * operator's hold on one observatory (ADR-019).
 *
 * Phase 1 has no sky sensor, so an operator looking out of a window is the only
 * thing that can declare the weather unsafe.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const path = zAdminSetWeatherHoldPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such observatory.");

  const parsed = zSetWeatherHoldRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_FAILED", "A hold state and a weather status are required.");
  }

  // Declaring a hold is never metered; clearing one is. The rule lives beside
  // `setWeatherHold` so it is testable on its own.
  if (!weatherHoldIsExemptFromMetering(parsed.data)) {
    const limited = await meterRequest({
      policy: ADMIN_MUTATION_POLICY,
      scope: "admin-weather-hold-clear",
      identity: guard.session.user.id,
      category: "SAFETY",
      actorUserId: guard.session.user.id,
    });
    if (limited) return limited;
  }

  const result = await setWeatherHold({
    observatoryId: path.data.observatoryId,
    request: parsed.data,
    actorUserId: guard.session.user.id,
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.weather);
}
