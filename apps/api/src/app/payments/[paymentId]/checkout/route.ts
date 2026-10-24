import { zGetPaymentCheckoutPath } from "@darkview/contracts/zod";

import { openBogCheckout } from "@/features/payments/bog-checkout";
import { requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { BOOKING_POLICY, meterRequest } from "@/lib/security/rate-limit";

/**
 * GET /payments/{paymentId}/checkout (ADR-073): a BOG_IPAY payment's
 * `redirectUrl`. Opens the bank's order on the first visit and answers 303 to the
 * bank's page, or to the purchase's own page once there is nothing left to pay.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ paymentId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: BOOKING_POLICY,
    scope: "payment-checkout",
    identity: guard.session.user.id,
    category: "PAYMENT",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  const path = zGetPaymentCheckoutPath.safeParse(await context.params);
  if (!path.success) return apiError(404, "NOT_FOUND", "No such payment.");

  const result = await openBogCheckout({
    userId: guard.session.user.id,
    paymentId: path.data.paymentId,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, {
    status: 303,
    headers: { location: result.location, "cache-control": "no-store" },
  });
}
