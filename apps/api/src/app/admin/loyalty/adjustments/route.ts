import { zLoyaltyAdjustmentRequest } from "@darkview/contracts/zod";

import { adjustLoyaltyPoints } from "@/features/loyalty/account";
import { requireOperatorMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, ADMIN_MUTATION_POLICY } from "@/lib/security/rate-limit";

/**
 * POST /admin/loyalty/adjustments -- an operator adds or removes points (DV-092).
 *
 * Idempotent by `adjustmentId`, never raises a tier, and audited with the operator
 * and the reason.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requireOperatorMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: ADMIN_MUTATION_POLICY,
    scope: "loyalty-adjustment",
    identity: guard.session.user.id,
    category: "LOYALTY",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const parsed = zLoyaltyAdjustmentRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return apiError(422, "VALIDATION_FAILED", "LoyaltyAdjustmentRequest is malformed.");
  }

  const result = await adjustLoyaltyPoints({
    request: parsed.data,
    operatorId: guard.session.user.id,
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.account);
}
