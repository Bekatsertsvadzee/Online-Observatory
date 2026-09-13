import { zMissionId } from "@darkview/contracts/zod";

import { purchaseObserverPack } from "@/features/missions/observer-pack";
import { requireApiMutation } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, OBSERVER_SEAT_POLICY } from "@/lib/security/rate-limit";

/**
 * Buy a view-only seat on somebody else's live session (ADR-007, DV-102).
 *
 * The seat is held while the payment is outstanding, exactly as `POST /bookings`
 * holds a slot, and it becomes usable when the provider callback settles the
 * payment. `POST /missions/{missionId}/observers` is what attaches to it.
 *
 * There is no request body. Everything the sale needs is the mission in the path
 * and the session cookie: the price is Darkview's to set, not the caller's to
 * propose, and a body carrying an amount is how a client talks a server into
 * selling something for nothing.
 */
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
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

  const result = await purchaseObserverPack({
    missionId,
    userId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.value, { status: 201 });
}
