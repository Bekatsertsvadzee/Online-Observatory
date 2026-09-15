import { zAdminIssueDeviceTokenPath, zDeviceTokenChangeRequest } from "@darkview/contracts/zod";

import { issueDeviceToken } from "@/features/admin/device-token";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /admin/network/nodes/{nodeId}/device-token -- issue a node's token (ADR-020).
 *
 * Metered: issuing lets an agent onto the network, which is the starting
 * direction. `no-store`, because this body is the only copy of the token there
 * will ever be, and a cache holding it would be a second one.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ nodeId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const path = zAdminIssueDeviceTokenPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such node.");

  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "admin-network-node-device-token-issue",
    identity: guard.session.user.id,
    category: "OBSERVATORY_MODE",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const body = zDeviceTokenChangeRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "A reason of at least eight characters is required.");
  }

  const result = await issueDeviceToken({
    nodeId: path.data.nodeId,
    request: body.data,
    operatorId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.issued, {
    status: 201,
    headers: { "cache-control": "no-store" },
  });
}
