import { submitNetworkNodeForReview } from "@/features/network/nodes";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { ADMIN_MUTATION_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * POST /network/nodes/{nodeId}/submit -- the owner offers a node for review.
 *
 * DRAFT to UNDER_REVIEW, and nothing else. It grants no authority: ADR-013 puts a
 * person between a stranger's telescope and a customer, and this is the owner
 * knocking on that person's door.
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ nodeId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "network-node-submit",
    identity: guard.session.user.id,
    category: "OBSERVATORY_MODE",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const { nodeId } = await context.params;
  const result = await submitNetworkNodeForReview({
    ownerId: guard.session.user.id,
    nodeId,
  });

  if (!result.ok) {
    return apiError(
      result.status,
      result.status === 404 ? "NOT_FOUND" : "CONFLICT",
      result.message,
    );
  }

  return Response.json(result.node);
}
