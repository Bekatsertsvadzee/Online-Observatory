import { zPurchaseGiftVoucherBody } from "@darkview/contracts/zod";

import { listMyGiftVouchers, purchaseGiftVoucher } from "@/features/vouchers/vouchers";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, VOUCHER_PURCHASE_POLICY } from "@/lib/security/rate-limit";

/**
 * GET /vouchers -- the gift vouchers the signed-in user bought, never their codes.
 * POST /vouchers -- buy one (DV-112).
 *
 * The price is Darkview's, read from the slot price for the length; the body names
 * only the length and where the code goes.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  return Response.json(await listMyGiftVouchers(guard.session.user.id, new Date()));
}

export async function POST(request: Request) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const limited = await meterRequest({
    policy: VOUCHER_PURCHASE_POLICY,
    scope: "voucher-purchase",
    identity: guard.session.user.id,
    category: "PAYMENT",
    actorUserId: guard.session.user.id,
  });
  if (limited) return limited;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return apiError(400, "BAD_REQUEST", "Body must be JSON.");
  }

  const body = zPurchaseGiftVoucherBody.safeParse(payload);
  if (!body.success) {
    return apiError(422, "VALIDATION_FAILED", "CreateGiftVoucherRequest is malformed.");
  }

  const result = await purchaseGiftVoucher({
    userId: guard.session.user.id,
    request: body.data,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.body, { status: 201 });
}
