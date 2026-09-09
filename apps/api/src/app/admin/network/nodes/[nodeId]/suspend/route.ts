import { zSuspendNetworkNodeRequest } from "@darkview/contracts/zod";

import { suspendNetworkNode } from "@/features/admin/network";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * POST /admin/network/nodes/{nodeId}/suspend -- take a qualification away, now.
 *
 * The emergency stop for a telescope nobody is standing next to. Unmetered, for
 * the reason DV-115 leaves Park unmetered: a limiter able to delay this would be
 * a regression dressed as hardening, and the moment an operator most needs it is
 * the moment they have been hammering the console.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ nodeId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const body = zSuspendNetworkNodeRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "The request is malformed.");
  }

  const { nodeId } = await context.params;
  const result = await suspendNetworkNode({
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
