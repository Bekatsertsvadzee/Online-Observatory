import { zPaymentWebhookEnvelope } from "@darkview/contracts/zod";
import { recordAuditEvent } from "@darkview/db/audit";

import { resolvePaymentProvider } from "@/features/payments/provider";
import { settlePayment } from "@/features/payments/settle";
import { getDatabase } from "@/lib/db/client";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, PAYMENT_WEBHOOK_POLICY, requestActor } from "@/lib/security/rate-limit";

/**
 * POST /payments/webhook -- the payment provider's callback.
 *
 * There is no session here: the caller is a provider's server, and what
 * authenticates it is its signature over the exact bytes of the body. So the
 * body is read as text first and parsed second, and the signature is checked
 * against the text -- a body re-serialised from parsed JSON is not the body
 * that was signed.
 *
 * Everything before the signature check is cheap and reveals nothing. Everything
 * after it trusts the provider's word and checks it against the records.
 */
export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "x-darkview-payment-signature";

export async function POST(request: Request) {
  // Metered by address before the body is read, to bound what a flood of
  // forged bodies can cost; never a reason a real provider's callback is lost,
  // only late -- see PAYMENT_WEBHOOK_POLICY.
  const limited = await meterRequest({
    policy: PAYMENT_WEBHOOK_POLICY,
    scope: "payment-webhook",
    identity: await requestActor(),
    category: "PAYMENT",
  });
  if (limited) return limited;

  const rawBody = await request.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const envelope = zPaymentWebhookEnvelope.safeParse(payload);
  if (!envelope.success) {
    return apiError(400, "BAD_REQUEST", "PaymentWebhookEnvelope is malformed.");
  }

  const provider = resolvePaymentProvider(envelope.data.provider);
  if (!provider.ok) {
    return apiError(
      provider.status,
      provider.status === 401 ? "UNAUTHENTICATED" : "INTERNAL",
      provider.message,
    );
  }

  const signature = request.headers.get(SIGNATURE_HEADER);
  if (!signature || !provider.adapter.verifySignature(rawBody, signature)) {
    // Written outside a transaction: the refusal changes nothing else. Without
    // it a forged callback and one that never arrived look the same in the logs.
    await recordAuditEvent(
      {
        category: "PAYMENT",
        action: "PAYMENT_WEBHOOK_REFUSED",
        detail: {
          provider: envelope.data.provider,
          reason: signature ? "BAD_SIGNATURE" : "MISSING_SIGNATURE",
        },
      },
      getDatabase(),
    );
    return apiError(401, "UNAUTHENTICATED", "The callback signature did not verify.");
  }

  const outcome = provider.adapter.readOutcome(envelope.data.payload);
  if (!outcome) {
    return apiError(400, "BAD_REQUEST", "The provider payload could not be read.");
  }

  const result = await settlePayment({
    provider: envelope.data.provider,
    outcome,
    now: new Date(),
  });

  if (!result.ok) {
    return apiError(result.status, result.code, result.message);
  }

  return Response.json({ received: true }, { status: 202 });
}
