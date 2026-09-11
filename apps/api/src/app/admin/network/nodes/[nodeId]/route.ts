import { zNodeId } from "@darkview/contracts/zod";

import { getNetworkNodeReview } from "@/features/admin/network";
import { requireOperator } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * GET /admin/network/nodes/{nodeId} -- everything an operator reads before
 * deciding a qualification.
 *
 * DV-122. A read: it grants nothing and changes nothing. Approving and suspending
 * remain the two POSTs beside it.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ nodeId: string }> },
) {
  const guard = await requireOperator();
  if (!guard.ok) return guard.response;

  const { nodeId } = await context.params;

  // A malformed id cannot name a node, so it is answered as one that does not
  // exist rather than as a validation failure the contract does not declare here.
  if (!zNodeId.safeParse(nodeId).success) {
    return apiError(404, "NOT_FOUND", "No such node.");
  }

  const review = await getNetworkNodeReview(nodeId);
  if (!review) return apiError(404, "NOT_FOUND", "No such node.");

  return Response.json(review);
}
