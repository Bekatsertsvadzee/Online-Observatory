import { zMissionId, zPurchaseObserverPackBody } from "@darkview/contracts/zod";

import { purchaseObserverPack } from "@/features/missions/observer-pack";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import {
  meterRequest,
  OBSERVER_SEAT_POLICY,
  VOUCHER_REDEMPTION_POLICY,
} from "@/lib/security/rate-limit";

/**
 * Buy a view-only seat on somebody else's live session (ADR-007, DV-102).
 *
 * The seat is held while the payment is outstanding, exactly as `POST /bookings`
 * holds a slot, and it becomes usable when the provider callback settles the
 * payment. `POST /missions/{missionId}/observers` is what attaches to it.
 *
 * The body is optional and carries at most an observer-seat prize code (ADR-060).
 * Everything else the sale needs is the mission in the path and the session cookie:
 * the price is Darkview's to set, not the caller's to propose, and a body carrying an
 * amount is how a client talks a server into selling something for nothing.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  // A purchase holds one of five seats on a live session, which is inventory in
  // the way a booking is. Metered on the same policy as the seat itself.
  const limited = await meterRequest({
    policy: OBSERVER_SEAT_POLICY,
    scope: "observer-pack",
    identity: guard.session.user.id,
    category: "PAYMENT",
    actorUserId: guard.session.user.id,
    missionId,
  });
  if (limited) return limited;

  const text = await request.text();
  let voucherCode: string | undefined;
  if (text.trim() !== "") {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return apiError(400, "BAD_REQUEST", "Body must be JSON.");
    }
    const body = zPurchaseObserverPackBody.safeParse(payload);
    if (!body.success) {
      return apiError(
        422,
        "VALIDATION_FAILED",
        "PurchaseObserverPackRequest is malformed.",
      );
    }
    voucherCode = body.data.voucherCode;
  }

  // As on POST /bookings: a code is metered as an attempt whether or not it is valid.
  if (voucherCode !== undefined) {
    const redemptionLimited = await meterRequest({
      policy: VOUCHER_REDEMPTION_POLICY,
      scope: "voucher-redemption",
      identity: guard.session.user.id,
      category: "PAYMENT",
      actorUserId: guard.session.user.id,
      missionId,
    });
    if (redemptionLimited) return redemptionLimited;
  }

  const result = await purchaseObserverPack({
    missionId,
    userId: guard.session.user.id,
    voucherCode,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.value, { status: 201 });
}
