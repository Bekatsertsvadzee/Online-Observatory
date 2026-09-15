import { zAdminSetObservatoryModePath, zSetObservatoryModeRequest } from "@darkview/contracts/zod";

import { setObservatoryMode } from "@/features/admin/observatory";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /admin/observatories/{observatoryId}/mode -- switch one observatory between
 * the simulator and real hardware.
 *
 * `requireOperatorMutation`, not `requireOperator`: this is a state change, the
 * session lives in a cookie, and a form on any page could otherwise submit here
 * with the operator's credentials attached. Of every route in this application
 * this is the one that must not be reachable cross-site.
 *
 * The id is the path's, never inferred (ADR-019): a switch to REAL names the
 * telescope it switches.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ observatoryId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const path = zAdminSetObservatoryModePath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such observatory.");

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
    observatoryId: path.data.observatoryId,
    request: parsed.data,
    actorUserId: guard.session.user.id,
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json({ mode: result.mode });
}
