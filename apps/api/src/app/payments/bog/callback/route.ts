import { receiveBogCallback } from "@/features/payments/bog-checkout";
import { meterRequest, PAYMENT_WEBHOOK_POLICY, requestActor } from "@/lib/security/rate-limit";

/**
 * POST /payments/bog/callback (ADR-073): Bank of Georgia's callback.
 *
 * No session and no trust in the body: it only names an order, and the payment is
 * settled from the receipt this API reads back from the bank.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const limited = await meterRequest({
    policy: PAYMENT_WEBHOOK_POLICY,
    scope: "payment-webhook",
    identity: await requestActor(),
    category: "PAYMENT",
  });
  if (limited) return limited;

  const { status } = await receiveBogCallback(await request.text(), new Date());
  return new Response(null, { status });
}
