import { zAdminUpdateTargetRequest, zTargetId } from "@darkview/contracts/zod";

import { updateTargetAsOperator } from "@/features/admin/targets";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";

/**
 * PATCH /admin/targets/{targetId} -- enable, disable or tune one target.
 *
 * PATCH rather than PUT, and partial rather than replacing: an operator flipping
 * `enabled` must not silently reset the imaging profile beside it to whatever
 * their client last read.
 */
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ targetId: string }> },
) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const { targetId } = await context.params;
  if (!zTargetId.safeParse(targetId).success) {
    return apiError(404, "NOT_FOUND", "No such target.");
  }

  const parsed = zAdminUpdateTargetRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return apiError(422, "VALIDATION_FAILED", "One or more known target fields are required.");
  }

  const result = await updateTargetAsOperator({
    targetId,
    request: parsed.data,
    operatorId: guard.session.user.id,
  });

  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.target);
}
