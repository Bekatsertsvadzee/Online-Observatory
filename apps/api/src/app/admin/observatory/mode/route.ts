import { zSetObservatoryModeRequest } from "@darkview/contracts/zod";

import { setObservatoryMode } from "@/features/admin/observatory";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";
import { currentObservatoryId } from "@/lib/http/current-observatory";

/**
 * POST /admin/observatory/mode -- switch between the simulator and real hardware.
 *
 * `requireOperatorMutation`, not `requireOperator`: this is a state change, the
 * session lives in a cookie, and a form on any page could otherwise submit here
 * with the operator's credentials attached. Of every route in this application
 * this is the one that must not be reachable cross-site.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const observatoryId = await currentObservatoryId();
  if (!observatoryId) {
    return apiError(404, "NOT_FOUND", "No observatory is configured.");
  }

  const parsed = zSetObservatoryModeRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(422, "VALIDATION_FAILED", "A mode, a reason and an attendance statement are required.");
  }

  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "admin-observatory-mode",
    identity: guard.session.user.id,
    category: "OBSERVATORY_MODE",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const result = await setObservatoryMode({
    observatoryId,
    request: parsed.data,
    actorUserId: guard.session.user.id,
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json({ mode: result.mode });
}
