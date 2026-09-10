import { zApproveNetworkNodeRequest } from "@darkview/contracts/zod";

import { approveNetworkNode } from "@/features/admin/network";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /admin/network/nodes/{nodeId}/approve -- qualify a partner observatory.
 *
 * ADR-013's single deliberate act: the one thing that lets a telescope somebody
 * else owns be operated by somebody neither of them has met, while nobody is
 * standing next to it.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ nodeId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "admin-network-node-approve",
    identity: guard.session.user.id,
    category: "OBSERVATORY_MODE",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const body = zApproveNetworkNodeRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "The request is malformed.");
  }

  const { nodeId } = await context.params;
  const result = await approveNetworkNode({
    nodeId,
    request: body.data,
    operatorId: guard.session.user.id,
    now: new Date(),
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message, result.details);
  }

  return Response.json(result.node);
}
