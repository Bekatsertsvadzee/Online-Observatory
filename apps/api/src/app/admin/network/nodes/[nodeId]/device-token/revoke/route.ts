import { zAdminRevokeDeviceTokenPath, zDeviceTokenChangeRequest } from "@darkview/contracts/zod";

import { revokeDeviceToken } from "@/features/admin/device-token";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /admin/network/nodes/{nodeId}/device-token/revoke -- take a node's token
 * away and close its link, now (ADR-020).
 *
 * Unmetered, for the reason suspension and Park are: a limiter able to delay this
 * would be a regression dressed as hardening, and the moment an operator most
 * needs it is the moment they have been hammering the console.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ nodeId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const path = zAdminRevokeDeviceTokenPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such node.");

  const body = zDeviceTokenChangeRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "A reason of at least eight characters is required.");
  }

  const result = await revokeDeviceToken({
    nodeId: path.data.nodeId,
    request: body.data,
    operatorId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, { status: 204 });
}
