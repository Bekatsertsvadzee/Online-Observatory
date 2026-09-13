import { zMissionId } from "@darkview/contracts/zod";

import {
  listMissionObservers,
  releaseObserverSeat,
  takeObserverSeat,
} from "@/features/missions/observers";
import { requireApiMutation, requireApiSession } from "@/lib/auth/api-guard";
import { apiError } from "@/lib/http/api-error";
import { meterRequest, OBSERVER_SEAT_POLICY } from "@/lib/security/rate-limit";

/**
 * Observer seats on a live mission (ADR-007).
 *
 * POST attaches to a seat that has already been bought. Buying one is
 * `POST /missions/{missionId}/observer-pack` (DV-102); this is what the customer
 * calls once their payment has settled, and again if their connection drops.
 *
 * The payment check is not here. It lives inside `takeObserverSeat`, in the same
 * locked transaction that counts the seats, so no route can be the one that
 * forgets it.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiSession();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  const result = await listMissionObservers({
    missionId,
    actor: { id: guard.session.user.id, role: guard.session.user.role },
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.value);
}

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

  // Metered for the reason the DELETE below is: ADR-007 caps a mission at five
  // seats, and attaching and detaching in a loop is work against a live session.
  const limited = await meterRequest({
    policy: OBSERVER_SEAT_POLICY,
    scope: "observer-seat",
    identity: guard.session.user.id,
    category: "MISSION",
    actorUserId: guard.session.user.id,
    missionId,
  });
  if (limited) return limited;

  const result = await takeObserverSeat({
    missionId,
    userId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return Response.json(result.value, { status: 201 });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ missionId: string }> },
) {
  const guard = await requireApiMutation();
  if (!guard.ok) return guard.response;

  const { missionId } = await context.params;
  if (!zMissionId.safeParse(missionId).success) {
    return apiError(404, "NOT_FOUND", "No such mission.");
  }

  // Metered, even though leaving is always allowed. ADR-007 caps a mission at
  // five seats; taking and releasing in a loop is how you would hold that cap
  // against other people without ever exceeding it.
  const limited = await meterRequest({
    policy: OBSERVER_SEAT_POLICY,
    scope: "observer-seat",
    identity: guard.session.user.id,
    category: "MISSION",
    actorUserId: guard.session.user.id,
    missionId,
  });
  if (limited) return limited;

  // Leaving is not gated on payment. Somebody holding a seat must always be able
  // to give it back, whatever the state of the thing that granted it.
  const result = await releaseObserverSeat({
    missionId,
    userId: guard.session.user.id,
    now: new Date(),
  });
  if (!result.ok) return apiError(result.status, result.code, result.message);

  return new Response(null, { status: 204 });
}
