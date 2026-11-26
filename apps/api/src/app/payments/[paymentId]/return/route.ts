import { zGetPaymentReturnPath } from "@darkview/contracts/zod";

import { returnFromBog } from "@/features/payments/bog-checkout";
import { meterRequest, PAYMENT_WEBHOOK_POLICY, requestActor } from "@/lib/security/rate-limit";
import { getServerEnvironment } from "@/lib/validation/env";

/**
 * GET /payments/{paymentId}/return (ADR-073, gateway v1.3.0): where the bank sends
 * the payer back, paid or not. Reads the bank's receipt at once and answers 303 to
 * the purchase's own page. No session: see `returnFromBog`.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ paymentId: string }> },
) {
  const limited = await meterRequest({
    policy: PAYMENT_WEBHOOK_POLICY,
    scope: "payment-return",
    identity: await requestActor(),
    category: "PAYMENT",
  });
  if (limited) return limited;

  const path = zGetPaymentReturnPath.safeParse(await context.params);
  const location = path.success
    ? await returnFromBog(path.data.paymentId, new Date())
    : new URL("/", getServerEnvironment().APP_URL).toString();

  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}
